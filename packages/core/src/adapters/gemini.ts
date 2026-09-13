import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, Detection, UsageEvent } from "../types.js";
import { walkFiles } from "./walk.js";

/**
 * Gemini CLI, read from its chat recordings.
 *
 * Recordings live at `~/.gemini/tmp/<project>/chats/session-*.jsonl`, one JSON object per
 * line. Only some lines carry usage: those written for a model turn have a top-level `tokens`
 * object beside `id`, `timestamp`, `type` and `model`. Everything else — user turns, the
 * `$set` envelopes carrying message history, tool traffic — has no counts and is skipped.
 *
 * ## Coverage is partial, and that is the honest description
 *
 * Token recording is a recent addition upstream. Measured on a real machine while writing
 * this: **2 of 2,141 session files** carried any token field at all. An installed Gemini CLI
 * whose older sessions cannot be counted is therefore a *partial* state rather than an absent
 * one, and this adapter reports what it can read without implying the rest was zero.
 *
 * ## The accounting, which is not what it looks like
 *
 * Each token object is `{ input, output, cached, thoughts, tool, total }`, and the tempting
 * reading — five disjoint components summing to `total` — is wrong. Tested against all 46
 * records available:
 *
 * - `input + output + cached + thoughts + tool === total` held for **9 of 46**
 * - `input + output + thoughts + tool === total` held for **46 of 46**
 *
 * `cached` is *inside* `input`, exactly as Codex reports `cached_input_tokens` inside
 * `input_tokens`. The nine records where the first reading appeared to work are precisely the
 * nine where `cached` is zero — so sampling one uncached turn would have confirmed the wrong
 * model and inflated every cache-heavy turn thereafter. One real record reports a total of
 * 8,776 where summing all five fields gives 15,837: an 80% overcount.
 *
 * The four disjoint buckets are therefore:
 *
 * - `input`      = `input - cached`
 * - `cacheRead`  = `cached`
 * - `output`     = `output + thoughts + tool`
 * - `cacheWrite` = 0, because Gemini reports no cache-write figure
 *
 * which sums to `input + output + thoughts + tool` — the reported `total`. That identity is
 * checked per record and used as reconciliation *evidence* rather than as an input: a record
 * whose components disagree with its own total is skipped rather than coerced, because a
 * silently forced match would hide exactly the schema change this note exists to survive.
 *
 * Folding `thoughts` and `tool` into `output` is a judgement rather than a measurement. Both
 * are generated tokens, and it is the placement that keeps the buckets disjoint; a pricing
 * table that distinguished reasoning rates would want them separated.
 *
 * ## What is deliberately not read
 *
 * `content` holds the prompt and reply verbatim, and `projectHash` identifies the working
 * directory. Neither is collected: transcripts and path identity — hashed or not — are outside
 * this tool's contract. Only the timestamp, the model id and the token counts are read.
 */

const defaultRoot = () => join(homedir(), ".gemini", "tmp");

/** The only fields read. Everything else on the line is ignored. */
type TokenCounts = {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
};

type Row = {
  id?: string;
  timestamp?: string;
  model?: string;
  tokens?: TokenCounts;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Turn one recorded turn into disjoint buckets, or null when it cannot be trusted.
 *
 * Exported for the tests, which assert the identity above against fixtures rather than taking
 * this file's word for it.
 */
export function bucketsFor(
  t: TokenCounts,
): { input: number; output: number; cacheWrite: number; cacheRead: number } | null {
  const input = num(t.input);
  const output = num(t.output);
  const cached = num(t.cached);
  const thoughts = num(t.thoughts);
  const tool = num(t.tool);

  // `cached` is a subset of `input`; a record claiming otherwise is not one we understand.
  if (cached > input) return null;

  const derived = input + output + thoughts + tool;

  /*
   * Reconcile against the provider's own total when it gave one.
   *
   * Skipped rather than forced. Coercing a mismatch — scaling, or trusting `total` over the
   * components — would let a future schema change pass silently as plausible numbers, which is
   * a worse failure than a missing turn. A record with no `total` is still usable: the
   * components are the measurement and the total is only the check.
   */
  if (typeof t.total === "number" && Number.isFinite(t.total) && t.total !== derived) return null;

  const buckets = {
    input: input - cached,
    output: output + thoughts + tool,
    cacheWrite: 0,
    cacheRead: cached,
  };

  return buckets.input + buckets.output + buckets.cacheRead > 0 ? buckets : null;
}

export function createGemini(root?: string): Adapter {
  const tmpRoot = root ?? defaultRoot();
  /* Only consult ~/.gemini when we are looking at the real one. A caller that names its own
     root — a test, or someone pointing at a copied home — must get an answer about *that*
     tree; falling back to the installed client's directory reported "installed-no-data" for a
     path that did not exist, purely because this machine happens to have Gemini installed. */
  const configRoot = root === undefined ? join(homedir(), ".gemini") : null;

  return {
    id: "gemini",
    name: "Gemini CLI",
    source: "~/.gemini/tmp/*/chats/*.jsonl",

    async detect(): Promise<Detection> {
      if (!(await stat(tmpRoot).catch(() => null))?.isDirectory()) {
        // The parent distinguishes absent from installed: ~/.gemini exists long before tmp.
        if (!configRoot) return "absent";
        const home = await stat(configRoot).catch(() => null);
        return home?.isDirectory() ? "installed-no-data" : "absent";
      }

      /*
       * A session file is not enough — most carry no counts. Detection reports `ready` only
       * once a countable turn has actually been found, so a user with years of older
       * recordings is told the truth rather than shown a confident zero.
       */
      for await (const path of walkFiles(tmpRoot, ".jsonl")) {
        for (const row of await rowsOf(path)) {
          if (row.tokens && bucketsFor(row.tokens)) return "ready";
        }
      }
      return "installed-no-data";
    },

    async *read(): AsyncIterable<UsageEvent> {
      /*
       * Keyed by message id across the whole scan.
       *
       * A turn is rewritten as it streams and a resumed session replays earlier turns, so the
       * same id recurs both within a file and across files. Last write wins rather than first:
       * a revision supersedes the partial turn it replaces. Counting both would double the
       * turn; counting the first would keep a truncated reading forever.
       */
      const seen = new Map<string, UsageEvent>();
      let anonymous = 0;

      for await (const path of walkFiles(tmpRoot, ".jsonl")) {
        for (const row of await rowsOf(path)) {
          if (!row.tokens) continue;

          const buckets = bucketsFor(row.tokens);
          if (!buckets) continue;

          const ts = row.timestamp ? new Date(row.timestamp) : null;
          if (!ts || Number.isNaN(ts.getTime())) continue;

          const event: UsageEvent = {
            agent: "gemini",
            ts,
            // Verbatim, like every other adapter. An unknown id is unpriced, never dropped.
            model: row.model ?? "unknown",
            ...buckets,
          };

          /* A turn with no id cannot be deduplicated, so it is kept under a unique key rather
             than discarded: losing real usage is worse than a small risk of double-counting a
             record the format does not let us identify. */
          seen.set(typeof row.id === "string" && row.id ? row.id : ` anon-${anonymous++}`, event);
        }
      }

      yield* seen.values();
    },
  };
}

/**
 * Parse one recording into rows, skipping whatever cannot be read.
 *
 * A half-written final line is normal — the file is appended to while a session runs — so a
 * malformed line is dropped and the rest of the file kept. Throwing here would let one
 * truncated recording hide every other session on the machine.
 */
async function rowsOf(path: string): Promise<Row[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Row);
    } catch {
      // Truncated or partially flushed. Skip the line, keep the file.
    }
  }
  return rows;
}

export const gemini: Adapter = createGemini();
