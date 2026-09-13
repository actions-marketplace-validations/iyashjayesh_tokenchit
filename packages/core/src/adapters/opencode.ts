import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, Detection, UsageEvent } from "../types.js";

const defaultDb = () => join(homedir(), ".local", "share", "opencode", "opencode.db");

type OpenCodeMessage = {
  role?: string;
  modelID?: string;
  providerID?: string;
  time?: { created?: number };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
};

/**
 * OpenCode keeps everything in a single SQLite database, with each message's usage stored as
 * a JSON blob in `message.data`. We open it read-only: the user may well have OpenCode
 * running, and a stat card is never worth risking someone's session history.
 *
 * The blob also carries a `cost` field, which we deliberately ignore. It reads 0 for
 * subscription and bundled providers — 216 assistant messages and 17.5M tokens came back at
 * $0.00 on the machine this was written on — so trusting it would silently zero out real
 * usage. Cost is recomputed from the price table like every other agent's.
 */
export function createOpenCode(dbPath = defaultDb()): Adapter {
  return {
    id: "opencode",
    name: "OpenCode",
    source: "~/.local/share/opencode/opencode.db",

    async detect(): Promise<Detection> {
      const file = await stat(dbPath).catch(() => null);
      if (!file?.isFile()) return "absent";

      /*
       * Asked of sqlite rather than by draining `read()`.
       *
       * `for await (const _ of this.read()) return "ready"` looks like an early exit and is
       * not: `.all()` materialises every row of the message table before the first iteration,
       * so the early return saved nothing. `readAll` calls `detect()` and then `read()`, which
       * meant the whole table was loaded twice on every sync, publish, recap and rebuild —
       * the memory ceiling of the tool for anyone with a large OpenCode history.
       *
       * `LIMIT 1` answers the same question in constant memory.
       */
      const { DatabaseSync } = await import("node:sqlite");

      let handle;
      try {
        handle = new DatabaseSync(dbPath, { readOnly: true });
      } catch {
        return "absent"; // Locked, or newer than this Node's sqlite: nothing to contribute.
      }

      try {
        const row = handle
          .prepare("SELECT 1 FROM message WHERE json_extract(data, '$.role') = 'assistant' LIMIT 1")
          .get();
        return row ? "ready" : "installed-no-data";
      } catch {
        // No `message` table, or a schema this build does not understand.
        return "installed-no-data";
      } finally {
        handle.close();
      }
    },

    async *read(): AsyncIterable<UsageEvent> {
      const file = await stat(dbPath).catch(() => null);
      if (!file?.isFile()) return;

      // Imported lazily so that a machine without OpenCode never pays for loading the sqlite
      // binding, and so the experimental-feature warning is only ever risked when it is used.
      const { DatabaseSync } = await import("node:sqlite");

      let handle;
      try {
        handle = new DatabaseSync(dbPath, { readOnly: true });
      } catch {
        return; // Database locked or newer than this Node's sqlite: contribute nothing.
      }

      /*
       * The session identity is a *column*, not a field of the blob.
       *
       * `data` carries agent, mode, model, cost, timing and tokens — and no id of any kind.
       * The identity this ledger merges on lives in `message.session_id`, with `message.id` as
       * the per-message fallback, which is why the projection asks for all three. Reading only
       * `data` left every OpenCode day unattributable: real usage, banked where it could never
       * be told apart from a copy of itself, so two machines could never merge it.
       *
       * The columns are asked for optimistically and the query falls back if this build of
       * OpenCode does not have them — a schema we do not control is not one to assume.
       */
      const rows = (() => {
        try {
          return handle.prepare("SELECT session_id, id, data FROM message").all() as {
            session_id?: string;
            id?: string;
            data: string;
          }[];
        } catch {
          return handle.prepare("SELECT data FROM message").all() as {
            session_id?: string;
            id?: string;
            data: string;
          }[];
        }
      })();

      try {
        for (const row of rows) {
          let msg: OpenCodeMessage;
          try {
            msg = JSON.parse(row.data) as OpenCodeMessage;
          } catch {
            continue;
          }

          if (msg.role !== "assistant" || !msg.tokens) continue;

          const created = msg.time?.created;
          if (typeof created !== "number") continue;
          const ts = new Date(created);
          if (Number.isNaN(ts.getTime())) continue;

          const t = msg.tokens;
          yield {
            agent: "opencode",
            ts,
            model: msg.modelID ?? "unknown",
            input: t.input ?? 0,
            // OpenCode counts reasoning beside output rather than inside it; folding it in
            // keeps the four buckets summing to the `total` it reports.
            output: (t.output ?? 0) + (t.reasoning ?? 0),
            cacheWrite: t.cache?.write ?? 0,
            cacheRead: t.cache?.read ?? 0,
            /* Session first, message id second. Either is device-independent and either
               answers the question the ledger asks — "is this the same work seen twice?" — so
               the coarser one is preferred only because it stores smaller. Neither is a path
               and neither is displayed; see `ledger.ts` for what is done with it. */
            ...(sourceOf(row) ? { sourceId: sourceOf(row) } : {}),
          };
        }
      } finally {
        handle.close();
      }
    },
  };
}

export const opencode: Adapter = createOpenCode();

/**
 * A device-independent identity for one OpenCode message, or undefined.
 *
 * Undefined is a supported answer, not a failure: usage with no source identity is banked
 * separately and never merged across machines, which is the honest handling of "we cannot
 * tell whether this is the same work".
 */
const sourceOf = (row: { session_id?: string; id?: string }): string | undefined =>
  row.session_id || row.id || undefined;
