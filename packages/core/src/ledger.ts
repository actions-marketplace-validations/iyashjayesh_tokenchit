import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { localDay } from "./aggregate.js";
import type { AgentId, UsageEvent } from "./types.js";

/**
 * A local, append-only record of usage this machine has already seen.
 *
 * The tool reads agent logs, and agent logs are deleted. Claude Code's `cleanupPeriodDays`
 * defaults to 30, so a card built only from what is on disk does not report "tokens burned
 * this year" — it reports "tokens burned since the last cleanup", and that boundary moves
 * every night. Measured on one machine: the stats cache remembered 82 active days while the
 * transcripts held 42, so over half the history had already gone, and `windows.year` and
 * `windows.all` were the same number because nothing survived long enough to differ.
 *
 * The ledger is the answer. Every run banks what it saw; later runs merge their reading with
 * the bank. Once a day is recorded, retention can delete the transcripts and the figure
 * survives.
 *
 * What it cannot do is recover history from before it existed. `since` is therefore a real
 * date and not a promise: days before it are only as complete as the logs were on the day it
 * was first written.
 *
 * ## Why a day total was not enough (version 2)
 *
 * Version 1 stored `day -> agent -> model -> Bucket` and kept the fullest reading per cell.
 * That rule is right for one machine reading its own thinning logs and says nothing at all
 * about two machines. Given a day where a laptop reports 1M and a desktop reports 1M, max-wins
 * answers 1M and addition answers 2M, and a day total carries no evidence for choosing. A
 * machine identifier is not evidence either: people copy home directories, restore backups and
 * migrate logs, so "different device" does not mean "different work".
 *
 * What *is* evidence is the agents' own session identifiers — `sessionId` on a Claude Code
 * transcript row, `session_meta.session_id` in a Codex rollout, `sessionId` in a Gemini
 * recording, `sessionID` on an OpenCode message. They travel with the data rather than with
 * the device. Version 2 therefore banks per `(day, agent, model, source)` and merges by two
 * rules, each used only where it is provable:
 *
 * - **within one source: max-wins** — two readings of one session are two observations of one
 *   thing, and the fuller one is the truer one. This is version 1's rule, applied at the level
 *   that justifies it.
 * - **across distinct sources: addition** — not arbitrary addition, but addition over work the
 *   agents themselves certify as distinct.
 *
 * Repeated import is idempotent by construction rather than by a deduplication pass that has
 * to be trusted.
 *
 * ## Usage with no identity
 *
 * Two things produce it: a version 1 ledger being migrated, and any record an adapter cannot
 * attribute. Neither may be guessed at, so neither is merged across machines.
 *
 * `Cell.u` holds, per origin, **the fullest whole-cell total that origin has ever observed** —
 * which is exactly what a version 1 ledger entry was. It is a *floor*, not an addend:
 *
 *     cell total for this machine = max( sum of identified sessions , u[this origin] )
 *
 * A max rather than a sum, because the two are readings of the same logs and not complementary
 * halves of them. Summing them double-counts, and this is not hypothetical: on the machine this
 * was written on, five OpenCode cells were banked once without identity and again with it after
 * the adapter learned where OpenCode keeps its session id, and adding the two reported 35.2M
 * for 17.6M of work.
 *
 * As a floor it does every job that is wanted of it. A migrated version 1 ledger keeps counting
 * in full. A day whose transcripts have rotated keeps the figure it had when they were there.
 * An adapter that gains identity overtakes its own older aggregate rather than doubling it. And
 * a foreign origin's floor is preserved and reported but **never counted**, because nothing in
 * an aggregate distinguishes independent work from a copy of work already counted.
 */
export type Ledger = {
  version: 2;
  /** When this file was first written, which is what "since installation" means. */
  since: string;
  updatedAt: string;
  /**
   * A random label minted once, for keeping one machine's unattributable history distinct
   * from another's.
   *
   * Deliberately **not** a device fingerprint: not a hostname, MAC address, username or path,
   * nor derived from any of them. Those are outside this tool's contract, and the design does
   * not need them — it never treats "a different origin" as proof of different usage.
   *
   * It travels with the file, which is the conservative behaviour: copying the config
   * directory to a new machine carries the origin along, so the two ledgers' unattributable
   * history max-merges as one lineage instead of summing as two.
   */
  origin: string;
  /** The IANA zone this machine banked its local days in. Interpretation only; see below. */
  tz: string;
  days: Record<string, Record<string, Record<string, Cell>>>;
  /**
   * Set when this ledger was just migrated from version 1, and **never written to disk**.
   *
   * Transient on purpose: it exists so the CLI can say, once, that the format changed — and
   * name the way to keep a copy that no version of this tool will overwrite. `writeLedger`
   * strips it, so the next read is a plain v2 and the notice does not repeat.
   */
  migratedFrom?: 1;
};

/** One `(day, agent, model)` cell: identified work, and the unidentified floor beneath it. */
export type Cell = {
  /** `sourceDigest -> bucket`. Union across ledgers, max within a key, sum across keys. */
  s: Record<string, Bucket>;
  /**
   * `originId -> bucket`: the fullest whole-cell total that origin ever observed with no
   * session identity to hang it on. A floor under `s`, never added to it, and never merged
   * across origins. See the note at the top of this file.
   */
  u?: Record<string, Bucket>;
};

/** The four token buckets, kept as a tuple so a day costs a handful of bytes, not a hundred. */
export type Bucket = [input: number, output: number, cacheWrite: number, cacheRead: number];

/** What the bank recovered on one run: days the logs no longer covered in full. */
export type Recovered = { days: number; tokens: number };

/** One banking decision, replayable against a ledger re-read inside the commit lock. */
export type BankOp = {
  day: string;
  agent: string;
  model: string;
  /** `null` when the adapter could not attribute the record. */
  source: string | null;
  b: Bucket;
};

export const sum = (b: Bucket): number => b[0] + b[1] + b[2] + b[3];

const add = (a: Bucket, b: Bucket): Bucket => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];

const ZERO: Bucket = [0, 0, 0, 0];

// NUL-separated. A model id carries routing prefixes, region prefixes, deployment suffixes
// and snapshot dates, so a space is not safe to split on; a null byte cannot occur in one.
const SEP = "\u0000";
const key = (day: string, agent: string, model: string, source: string | null): string =>
  `${day}${SEP}${agent}${SEP}${model}${SEP}${source ?? ""}`;

/**
 * A device-independent digest of one session identity.
 *
 * Unsalted on purpose: two machines must derive the same digest from the same session or the
 * whole scheme fails. Truncated to 48 bits, which trades a collision risk — two distinct
 * sessions colliding would merge and *under*count — for size. The birthday bound at 48 bits is
 * around 16 million entries and a heavy ledger holds thousands.
 *
 * Hashed rather than stored raw so that an exported file carries no identifier that could be
 * cross-referenced against the log filenames on someone's disk. It costs nothing: the digest is
 * only ever compared for equality.
 */
export const sourceDigest = (agent: string, sourceId: string): string =>
  createHash("sha256").update(`${agent}${SEP}${sourceId}`).digest("hex").slice(0, 12);

/** This machine's IANA zone, or `UTC` where the runtime will not say. */
const localZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/**
 * Where the bank lives.
 *
 * Beside `auth.json` in the user's config directory rather than in the repo: it is machine
 * state, it is not meant to be committed, and a `git add -A` must not be able to reach it.
 */
export const ledgerPath = (): string =>
  join(
    process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
    "tokenchit",
    "ledger.json",
  );

/** The copy taken before an import replaces the live file. */
export const backupPath = (path = ledgerPath()): string =>
  `${path.replace(/\.json$/, "")}.backup.json`;

export const emptyLedger = (now = new Date()): Ledger => ({
  version: 2,
  since: localDay(now),
  updatedAt: now.toISOString(),
  origin: randomUUID(),
  tz: localZone(),
  days: {},
});

/** The pre-identity shape, still on disk for anyone who has not run this version yet. */
type LedgerV1 = {
  version: 1;
  since?: string;
  updatedAt?: string;
  days?: Record<string, Record<string, Record<string, Bucket>>>;
};

/**
 * Keys that are not data, whatever a file claims.
 *
 * The ledger is built by walking untrusted trees — an imported export, or a ledger.json
 * somebody hand-edited — and assigning into nested objects with `??=`. An agent or model key
 * of `__proto__` turns that assignment into a write to `Object.prototype`, which is a real
 * attack and not a theoretical one: it was reachable from a crafted import file before this
 * existed, and it poisons every object in the process, not just this ledger.
 *
 * Refused rather than escaped. No agent, model, day, session digest or origin is ever legally
 * named any of these, so there is nothing to preserve and nothing to encode.
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Whether a key read from an untrusted tree may be used as an object key. */
export const safeKey = (k: unknown): k is string =>
  typeof k === "string" && k.length > 0 && !UNSAFE_KEYS.has(k);

export const isBucket = (v: unknown): v is Bucket =>
  Array.isArray(v) &&
  v.length === 4 &&
  v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

/**
 * Read the bank, or an empty one.
 *
 * A missing, unreadable or unrecognised file is an empty ledger, never an error. Losing
 * history is bad; failing someone's `sync` because a JSON file got truncated is worse, and
 * the next write repairs it from whatever logs are still on disk.
 */
export async function readLedger(path = ledgerPath()): Promise<Ledger> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return emptyLedger();
  }
  return adopt(parsed);
}

/**
 * Bring whatever was on disk up to the current shape.
 *
 * A version 1 ledger is **migrated, not discarded**: its days become this origin's archive, so
 * every token it held keeps counting while the identified reading underneath it is rebuilt
 * from the logs that are still there. A user who upgrades mid-year must not watch their total
 * drop, and one whose transcripts have already rotated must not lose the only copy.
 */
export function adopt(parsed: unknown): Ledger {
  const base = emptyLedger();
  if (!parsed || typeof parsed !== "object") return base;

  /* Both shapes at once, with `version` widened: an intersection of the two collapses to
     `never` because their literal versions disagree, which is exactly the discrimination this
     function exists to perform by hand. */
  const raw = parsed as Omit<Partial<Ledger>, "version"> &
    Omit<LedgerV1, "version"> & { version?: number };

  if (raw.version === 1) {
    /*
     * Migrated, not discarded. A version 1 entry *is* a whole-cell total with no identity, so
     * it becomes exactly that: this origin's floor for that cell. Every token keeps counting,
     * the identified reading is rebuilt underneath it from whatever logs are still there, and
     * whichever is fuller wins. A user who upgrades mid-year must not watch their total drop,
     * and one whose transcripts have already rotated must not lose the only copy.
     */
    const since = typeof raw.since === "string" ? raw.since : base.since;
    const migrated: Ledger = { ...base, since, days: {} };
    for (const [day, byAgent] of Object.entries(raw.days ?? {})) {
      if (!byAgent || typeof byAgent !== "object") continue;
      for (const [agent, models] of Object.entries(byAgent)) {
        if (!models || typeof models !== "object") continue;
        for (const [model, b] of Object.entries(models)) {
          if (!isBucket(b) || sum(b) <= 0) continue;
          bank(migrated, day, agent, model, null, b);
        }
      }
    }
    /* Flagged so the CLI can say, once, that the format moved — and name `--export` as the way
       to keep a copy that no version of this tool will overwrite. Only when something was
       actually carried over: an empty v1 file is a migration nobody needs told about. */
    if (Object.keys(migrated.days).length > 0) migrated.migratedFrom = 1;
    return migrated;
  }

  if (raw.version !== 2 || !raw.days || typeof raw.days !== "object") return base;

  return {
    version: 2,
    since: typeof raw.since === "string" ? raw.since : base.since,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
    /* A file with no origin gets a fresh one rather than a shared constant: a constant would
       make every machine's unattributable history look like one lineage and silently collapse
       independent work under the max rule. */
    origin: typeof raw.origin === "string" && raw.origin ? raw.origin : base.origin,
    tz: typeof raw.tz === "string" && raw.tz ? raw.tz : base.tz,
    /* Sanitised on the way in, because this tree may have been hand-edited. Everything
       downstream assigns into it. */
    days: sanitiseDays(raw.days),
  };
}

/** Copy a `day -> agent -> model -> Cell` tree, dropping anything unusable. */
function sanitiseDays(days: unknown): Ledger["days"] {
  const out: Ledger["days"] = {};
  if (!days || typeof days !== "object") return out;

  for (const [day, byAgent] of Object.entries(days as Record<string, unknown>)) {
    if (!safeKey(day) || !byAgent || typeof byAgent !== "object") continue;

    for (const [agent, models] of Object.entries(byAgent as Record<string, unknown>)) {
      if (!safeKey(agent) || !models || typeof models !== "object") continue;

      for (const [model, cell] of Object.entries(models as Record<string, unknown>)) {
        if (!safeKey(model) || !cell || typeof cell !== "object") continue;
        const raw = cell as { s?: unknown; u?: unknown };

        const clean: Cell = { s: {} };
        for (const [digest, b] of Object.entries((raw.s ?? {}) as Record<string, unknown>)) {
          if (safeKey(digest) && isBucket(b)) clean.s[digest] = b;
        }
        for (const [origin, b] of Object.entries((raw.u ?? {}) as Record<string, unknown>)) {
          if (safeKey(origin) && isBucket(b)) (clean.u ??= {})[origin] = b;
        }

        if (Object.keys(clean.s).length > 0 || clean.u) {
          ((out[day] ??= {})[agent] ??= {})[model] = clean;
        }
      }
    }
  }
  return out;
}

/**
 * Write the bank.
 *
 * Through a temporary file and a rename, because this is the only copy of the history the
 * logs no longer hold. A process killed mid-write must not be able to truncate it.
 */
export async function writeLedger(ledger: Ledger, path = ledgerPath()): Promise<string> {
  // 0700: this directory holds the ledger and, beside it, the auth token.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  /* `migratedFrom` is a signal to this run, not a fact about the file. Writing it would make
     the notice repeat forever and leave a meaningless key in everybody's ledger. */
  const { migratedFrom: _migrated, ...persisted } = ledger;
  const body = JSON.stringify({ ...persisted, updatedAt: new Date().toISOString() });
  /* 0600 like auth.json beside it, and set at create time rather than chmod'ed after, so the
     contents are never briefly world-readable. This is a record of when this machine works and
     how hard; the default 0644 published that to every account on a shared box. */
  await writeFile(tmp, `${body}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  return path;
}

/**
 * Merge one observation into the bank.
 *
 * `source` null means the adapter could not attribute the record, and it is banked under this
 * ledger's own origin — never merged into another machine's.
 *
 * An observation is max-wins **on the whole four-tuple** rather than field by field: mixing
 * fields from two readings would bank a combination that never happened. Note this takes a
 * session's total for a model on a day, never a single event — banking events one at a time
 * with max-wins would keep the largest single call and throw away the rest.
 */
export function bank(
  ledger: Ledger,
  day: string,
  agent: string,
  model: string,
  source: string | null,
  b: Bucket,
): void {
  /* Refused here as well as at validation. This is the only function that creates the nested
     objects, so it is the one place a poisoned key could turn an assignment into a write to
     `Object.prototype` — and it is reached from imports, from scans and from a ledger read off
     disk, so guarding the callers one at a time would be a worse guarantee. */
  if (!safeKey(day) || !safeKey(agent) || !safeKey(model)) return;
  if (source !== null && !safeKey(source)) return;
  if (!safeKey(ledger.origin)) return;

  const cell = (((ledger.days[day] ??= {})[agent] ??= {})[model] ??= { s: {} });
  cell.s ??= {};

  /* A null source means `b` is this origin's reading of the *whole cell* with nothing to
     attribute it to — a floor, not a component. See `cellTotal`. */
  if (source === null) {
    const u = (cell.u ??= {});
    const seen = u[ledger.origin];
    if (!seen || sum(b) > sum(seen)) u[ledger.origin] = b;
    return;
  }

  const seen = cell.s[source];
  if (!seen || sum(b) > sum(seen)) cell.s[source] = b;
}

/**
 * What one cell is worth to *this* machine.
 *
 * Identified work sums across distinct sources, because the agents certify those as distinct.
 * This origin's unidentified reading is a **floor under** that sum, not a component of it:
 * both describe the same logs, so taking the larger is the only answer that is right whichever
 * of the two is more complete. Adding them double-counts — see the top of this file for the
 * real case where it did.
 *
 * A foreign origin's floor is excluded entirely. Nothing in an aggregate distinguishes
 * independent work from a copy of work already counted.
 */
export function cellTotal(cell: Cell | undefined, origin: string): Bucket {
  if (!cell) return ZERO;
  let identified: Bucket = ZERO;
  for (const b of Object.values(cell.s ?? {})) if (isBucket(b)) identified = add(identified, b);

  const floor = cell.u?.[origin];
  return isBucket(floor) && sum(floor) > sum(identified) ? floor : identified;
}

/** The figure this machine stands behind for one `(day, agent, model)`. */
export const localTotal = (ledger: Ledger, day: string, agent: string, model: string): Bucket =>
  cellTotal(ledger.days[day]?.[agent]?.[model], ledger.origin);

/** Every `(day, agent, model)` this machine counts. */
export function* localCells(
  ledger: Ledger,
): Generator<{ day: string; agent: string; model: string; b: Bucket }> {
  for (const [day, byAgent] of Object.entries(ledger.days)) {
    for (const [agent, models] of Object.entries(byAgent ?? {})) {
      for (const [model, cell] of Object.entries(models ?? {})) {
        const b = cellTotal(cell, ledger.origin);
        if (sum(b) > 0) yield { day, agent, model, b };
      }
    }
  }
}

/**
 * Pass every event through, then top up whatever the bank remembers more of.
 *
 * Live events are yielded untouched and first, so a day the logs still cover keeps its real
 * timestamps and its per-call detail. Their totals are accumulated as they go, per session,
 * and only once the stream is exhausted can those be compared against the bank.
 *
 * The comparison is a *top-up*, not a choice between sources. An earlier version replayed
 * only days the live read had not mentioned at all, which silently regressed the case this
 * whole file exists for: retention eats a day gradually, so a half-rotated day is present,
 * smaller than it was, and would have been taken at its diminished value. Emitting the
 * shortfall instead means a day is worth the most anyone ever saw it be worth, whether it is
 * wholly gone or merely thinning.
 *
 * A top-up carries local noon, because the bank stores a day and not a clock. That is a real
 * loss: recovered tokens land in one cell of the hour histogram and the heatmap, exactly as a
 * Codex rollout already does. Totals, windows, streaks and the sparkline — the figures the
 * card actually reports — are unaffected, and a wrong hour is a much smaller lie than a
 * missing fortnight.
 *
 * `only` scopes both halves. A run reading just Codex must not have Claude Code days topped
 * up into it, or the card would disagree with the agents the config asked for.
 *
 * `ops` collects what this run decided to bank, so the caller can replay those decisions
 * against a ledger re-read under the commit lock instead of overwriting the file with a copy
 * that may be minutes stale. See `commitLedger`.
 */
export async function* recordAndReplay(
  events: AsyncIterable<UsageEvent>,
  ledger: Ledger,
  only?: readonly AgentId[],
  out?: Recovered,
  ops?: BankOp[],
): AsyncIterable<UsageEvent> {
  const scoped = (agent: string): boolean => !only?.length || only.includes(agent as AgentId);
  /** `(day, agent, model, source) -> bucket`, the unit the bank merges on. */
  const live = new Map<string, Bucket>();
  /** `(day, agent, model) -> bucket`, for comparing this run against the bank. */
  const liveCell = new Map<string, Bucket>();

  const accumulate = (map: Map<string, Bucket>, k: string, e: UsageEvent): void => {
    const acc = map.get(k);
    if (acc) {
      acc[0] += e.input;
      acc[1] += e.output;
      acc[2] += e.cacheWrite;
      acc[3] += e.cacheRead;
    } else {
      map.set(k, [e.input, e.output, e.cacheWrite, e.cacheRead]);
    }
  };

  for await (const event of events) {
    yield event;
    if (!scoped(event.agent)) continue;

    const day = localDay(event.ts);
    const source = event.sourceId ? sourceDigest(event.agent, event.sourceId) : null;
    accumulate(live, key(day, event.agent, event.model, source), event);
    accumulate(liveCell, key(day, event.agent, event.model, null), event);
  }

  const recoveredDays = new Set<string>();
  let recoveredTokens = 0;

  for (const { day, agent, model, b: banked } of localCells(ledger)) {
    if (!scoped(agent)) continue;
    const ts = noon(day);
    if (!ts) continue;

    const now = liveCell.get(key(day, agent, model, null)) ?? ZERO;
    if (sum(banked) - sum(now) <= 0) continue;

    const top: Bucket = [
      Math.max(0, banked[0] - now[0]),
      Math.max(0, banked[1] - now[1]),
      Math.max(0, banked[2] - now[2]),
      Math.max(0, banked[3] - now[3]),
    ];
    if (sum(top) <= 0) continue;

    recoveredDays.add(day);
    recoveredTokens += sum(top);
    yield {
      agent: agent as AgentId,
      ts,
      model,
      input: top[0],
      output: top[1],
      cacheWrite: top[2],
      cacheRead: top[3],
      /* The date is real; `noon` invented the clock. Tagged so anything asking when
         somebody works can exclude it, rather than reading a synthesised hour as though
         the user had been observed at midday. The heatmap keeps counting these — see the
         note above on why a missing fortnight is the worse lie — but the peak headline
         and the time-of-day badges do not. */
      tsPrecision: "day",
    };
  }

  /*
   * Banked after the comparison, so the shortfall above is measured against the previous state
   * rather than against a bank this same run has already raised.
   *
   * An unattributed event banks the **whole cell's** live total rather than its own share,
   * because `u` is a floor and not a component: a cell where the adapter identified 10 and
   * could not identify 5 is worth 15, and a floor of 5 would let the max report 10. Filing the
   * full 15 makes the floor do its job in exactly the mixed case that would otherwise lose
   * tokens, and costs nothing when the cell is wholly identified — there, no null-source op is
   * emitted at all.
   */
  for (const [k, b] of live) {
    const [day, agent, model, source] = k.split(SEP) as [string, string, string, string];
    const op: BankOp =
      source === ""
        ? { day, agent, model, source: null, b: liveCell.get(key(day, agent, model, null)) ?? b }
        : { day, agent, model, source, b };
    bank(ledger, op.day, op.agent, op.model, op.source, op.b);
    ops?.push(op);
  }

  if (out) {
    out.days = recoveredDays.size;
    out.tokens = recoveredTokens;
  }
}

/** Local noon on a `YYYY-MM-DD`, so `localDay` gives the same day back in any timezone. */
function noon(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The bank with one set of agents emptied, for a rebuild that only re-derives those agents.
 *
 * `scan({ fresh: true })` used to hand `recordAndReplay` a wholly empty `days`, but that
 * function only re-banks the agents in `only` — and `only` comes from the *repo's*
 * `.tokenchit.json` while the bank is global to the machine. Rebuilding in a repo configured
 * for claude-code alone therefore destroyed every banked Codex and OpenCode day on the machine
 * and re-derived none of them: the one piece of state here that cannot be read back off disk.
 *
 * An empty or absent `only` still clears everything, because that genuinely is the whole scope.
 *
 * A cleared cell takes its unidentified floor with it. A rebuild is the user saying "re-derive
 * this from the logs"; leaving the floor behind would max-win against the fresh reading and
 * silently restore exactly the figure they asked to discard. Another origin's floor goes too,
 * but only for the agents in scope — it lives in the same cell and there is no separate copy.
 */
export function withoutAgents(ledger: Ledger, only?: readonly AgentId[]): Ledger {
  if (!only?.length) return { ...ledger, days: {} };

  const days: Ledger["days"] = {};
  for (const [day, byAgent] of Object.entries(ledger.days)) {
    const kept: Record<string, Record<string, Cell>> = {};
    for (const [agent, models] of Object.entries(byAgent ?? {})) {
      if (!only.includes(agent as AgentId)) kept[agent] = models;
    }
    // A day with every agent cleared is dropped, not left as an empty husk that would count
    // toward `ledgerSummary().days` and report history that is no longer there.
    if (Object.keys(kept).length > 0) days[day] = kept;
  }
  return { ...ledger, days };
}

export function ledgerSummary(
  ledger: Ledger,
  /* Narrow the summary to the agents a caller is about to act on. `ledger --rebuild` quotes
     this before destroying anything, and quoting the whole bank there told the user they were
     discarding history the rebuild would in fact leave alone — or, worse, understated nothing
     while the command silently took more than it named. */
  only?: readonly AgentId[],
): {
  days: number;
  tokens: number;
  agents: string[];
  first: string | null;
  last: string | null;
} {
  const scoped = (agent: string): boolean => !only?.length || only.includes(agent as AgentId);
  const agents = new Set<string>();
  const days = new Set<string>();
  let tokens = 0;

  for (const cell of localCells(ledger)) {
    if (!scoped(cell.agent)) continue;
    agents.add(cell.agent);
    days.add(cell.day);
    tokens += sum(cell.b);
  }

  const sorted = [...days].sort();
  return {
    days: sorted.length,
    tokens,
    agents: [...agents].sort(),
    first: sorted[0] ?? null,
    last: sorted.at(-1) ?? null,
  };
}

export type ForeignHistory = {
  origin: string;
  days: number;
  tokens: number;
  first: string | null;
  last: string | null;
};

/**
 * Another machine's unidentified history: held, reported, and never counted.
 *
 * Surfaced by `ledger`, `doctor` and every import preview, so it is never quietly sitting in
 * the file. Adding it would be a guess — nothing in an aggregate distinguishes independent
 * work from a copy of work already counted — and discarding it would be a loss, so it is
 * neither. If the other machine is ever upgraded and re-exported with session identities, the
 * same days merge properly and this disappears on its own.
 */
export function foreignHistory(ledger: Ledger): ForeignHistory[] {
  const byOrigin = new Map<string, { tokens: number; days: Set<string> }>();

  for (const [day, byAgent] of Object.entries(ledger.days)) {
    for (const models of Object.values(byAgent ?? {})) {
      for (const cell of Object.values(models ?? {})) {
        for (const [origin, b] of Object.entries(cell?.u ?? {})) {
          if (origin === ledger.origin || !isBucket(b) || sum(b) <= 0) continue;
          const acc = byOrigin.get(origin) ?? { tokens: 0, days: new Set<string>() };
          acc.tokens += sum(b);
          acc.days.add(day);
          byOrigin.set(origin, acc);
        }
      }
    }
  }

  return [...byOrigin]
    .map(([origin, acc]) => {
      const days = [...acc.days].sort();
      return {
        origin,
        days: days.length,
        tokens: acc.tokens,
        first: days[0] ?? null,
        last: days.at(-1) ?? null,
      };
    })
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

/* ------------------------------------------------------------------ *
 * Serialising writers
 * ------------------------------------------------------------------ */

const lockPath = (path: string): string => `${path}.lock`;
/** A commit is a read, a merge and a rename. Anything holding the lock longer than this died. */
const STALE_MS = 60_000;
const WAIT_MS = 10_000;

/**
 * Run `fn` with exclusive access to the ledger.
 *
 * The hazard is not a torn file — `writeLedger` renames, so that cannot happen — it is a lost
 * update. A `sync` reads the bank, walks the logs for several seconds, then writes; an import
 * landing in that window would be silently overwritten. Both now do their read *inside* this
 * lock and apply their changes to what they find there.
 *
 * An abandoned lock is taken over rather than left to block forever: a process killed between
 * create and release would otherwise wedge every later run, and the operation it protects is
 * seconds long at most.
 */
export async function withLedgerLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      const held = await stat(lock).catch(() => null);
      if (held && Date.now() - held.mtimeMs > STALE_MS) {
        await rm(lock, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `another tokenchit process is writing the ledger (${lock}).\n` +
            "  Wait for it to finish, or delete that file if nothing is running.",
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lock, { force: true }).catch(() => {});
  }
}

/**
 * Apply this run's banking decisions to the ledger as it is *now*.
 *
 * Not a write-back of the copy the run started with. Replaying the decisions against a fresh
 * read is what keeps a `sync` from clobbering an import that landed while it was walking the
 * logs, and vice versa — the two are order-independent because both are merges.
 */
export async function commitLedger(
  ops: readonly BankOp[],
  opts: { clearAgents?: readonly AgentId[]; clearAll?: boolean; path?: string } = {},
): Promise<Ledger> {
  const path = opts.path ?? ledgerPath();
  return withLedgerLock(path, async () => {
    let fresh = await readLedger(path);
    if (opts.clearAll) fresh = withoutAgents(fresh, undefined);
    else if (opts.clearAgents?.length) fresh = withoutAgents(fresh, opts.clearAgents);

    for (const op of ops) bank(fresh, op.day, op.agent, op.model, op.source, op.b);
    await writeLedger(fresh, path);
    return fresh;
  });
}
