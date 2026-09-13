import {
  foreignHistory,
  isBucket,
  ledgerSummary,
  localCells,
  sum,
  type Bucket,
  type Cell,
  type ForeignHistory,
  type Ledger,
} from "./ledger.js";

/**
 * Moving a history between machines, without guessing.
 *
 * The format is deliberately small: normalised usage, plus exactly the provenance needed to
 * interpret it — accounting version, origin label, timezone, coverage dates. Nothing else
 * travels. No auth state, no raw logs, no prompts or replies, no repository names, no
 * filesystem paths, hashed or otherwise. A session identity is a truncated digest, not the
 * identifier itself, so an export cannot be cross-referenced against the log filenames on
 * anybody's disk.
 *
 * ## The one rule that makes this safe
 *
 * `ledger.ts` explains why a day total cannot say whether two machines saw the same work. The
 * merge here rests entirely on that file's answer: identified sessions union, max within a
 * digest and sum across digests, and anything without an identity is kept aside per origin
 * rather than added. There is no heuristic in this file. It validates, it unions, it reports.
 *
 * ## Preview is a forecast, not a promise
 *
 * `mergeExport` is pure, so the preview a user reads and the merge an apply performs are the
 * same function. The apply runs it again inside the lock against whatever the live ledger has
 * become, so a `sync` landing while somebody reads the preview changes the outcome only by
 * what that `sync` added — and never silently, because the apply reports its own numbers.
 */

export const EXPORT_FORMAT = "tokenchit-ledger-export";
/** The envelope's own version. Bumped if the file's shape changes. */
export const EXPORT_VERSION = 1;
/** The accounting rules the days inside were banked under. Must match `Ledger["version"]`. */
export const ACCOUNTING_VERSION = 2;

export type LedgerExport = {
  format: typeof EXPORT_FORMAT;
  version: number;
  accounting: number;
  exportedAt: string;
  /** The exporting ledger's random origin label. Not a device fingerprint — see `ledger.ts`. */
  origin: string;
  /** The zone its local days were binned in. Interpretation only; nothing is re-binned. */
  tz: string;
  since: string;
  coverage: { first: string | null; last: string | null; days: number; tokens: number };
  days: Ledger["days"];
};

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

/**
 * Build the export envelope. Pure: the live ledger is read and never touched.
 *
 * Unidentified history travels too, inside the cells where it lives. It is history somebody's
 * machine really did record, and dropping it at the door would lose it silently — the
 * importing side keeps it aside rather than counting it, which is the honest handling of an
 * aggregate that cannot be told apart from a duplicate.
 */
export function buildExport(ledger: Ledger, now = new Date()): LedgerExport {
  const s = ledgerSummary(ledger);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    accounting: ACCOUNTING_VERSION,
    exportedAt: now.toISOString(),
    origin: ledger.origin,
    tz: ledger.tz,
    since: ledger.since,
    coverage: { first: s.first, last: s.last, days: s.days, tokens: s.tokens },
    days: ledger.days,
  };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Bounds, all of them deliberate.
 *
 * A file arriving from another machine is untrusted input even when the user typed its path,
 * and the failure to avoid is not a crash — it is a plausible-looking import that quietly
 * corrupts the one piece of state here that cannot be re-derived. Every limit below sits far
 * above any real ledger and far below anything that could exhaust memory.
 */
export const LIMITS = {
  /** 64 MiB. A decade of heavy use is a few hundred kilobytes. */
  bytes: 64 * 1024 * 1024,
  days: 40_000,
  agentsPerDay: 64,
  modelsPerAgent: 512,
  sourcesPerCell: 200_000,
  originsPerCell: 64,
  /** Per bucket field. Above this the number is not a token count. */
  tokens: 1e15,
} as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST_RE = /^[0-9a-f]{6,64}$/;
/** Printable, no control characters, bounded. Applies to agent, model, origin and zone keys. */
const SAFE_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;

export type Invalid = { ok: false; errors: string[] };
export type Valid = { ok: true; value: LedgerExport };

/**
 * Check an untrusted parsed object all the way through before anything is written.
 *
 * Errors accumulate rather than throwing on the first, because a file with three problems
 * should be reported in one go — an import is something done rarely, under time pressure, on
 * a machine that is not the one with the problem.
 */
export function validateExport(parsed: unknown): Valid | Invalid {
  const errors: string[] = [];
  const fail = (msg: string): void => {
    if (errors.length < 20) errors.push(msg);
  };

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["not a JSON object"] };
  }
  const raw = parsed as Record<string, unknown>;

  if (raw["format"] !== EXPORT_FORMAT) {
    return {
      ok: false,
      errors: [
        `not a tokenchit ledger export (format is ${JSON.stringify(raw["format"]) ?? "absent"}, expected ${JSON.stringify(EXPORT_FORMAT)})`,
      ],
    };
  }

  const version = raw["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, errors: ["export version is missing or not a positive integer"] };
  }
  if (version > EXPORT_VERSION) {
    return {
      ok: false,
      errors: [
        `written by a newer tokenchit (export version ${version}; this build understands ${EXPORT_VERSION})`,
        "Upgrade tokenchit on this machine, then import again.",
      ],
    };
  }

  const accounting = raw["accounting"];
  if (accounting !== ACCOUNTING_VERSION) {
    return {
      ok: false,
      errors: [
        `incompatible accounting version ${JSON.stringify(accounting)} (this build merges version ${ACCOUNTING_VERSION})`,
        "Histories banked under different rules would produce a total neither machine stands behind.",
        "Re-export from a tokenchit build matching this one.",
      ],
    };
  }

  for (const field of ["origin", "tz", "since", "exportedAt"] as const) {
    const v = raw[field];
    if (typeof v !== "string" || !SAFE_RE.test(v)) fail(`${field} is missing or not a plain string`);
  }
  if (typeof raw["since"] === "string" && !DAY_RE.test(raw["since"])) {
    fail("since is not a YYYY-MM-DD date");
  }

  const days = raw["days"];
  if (!days || typeof days !== "object" || Array.isArray(days)) {
    return { ok: false, errors: [...errors, "days is missing or not an object"] };
  }
  checkDays(days as Record<string, unknown>, fail);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as LedgerExport };
}

/** Walk a `day -> agent -> model -> (cell | bucket)` tree against every bound. */
function checkDays(days: Record<string, unknown>, fail: (msg: string) => void, flat = false): void {
  const dayKeys = Object.keys(days);
  if (dayKeys.length > LIMITS.days) {
    fail(`too many days (${dayKeys.length}, limit ${LIMITS.days})`);
    return;
  }

  for (const day of dayKeys) {
    if (!DAY_RE.test(day)) {
      fail(`${JSON.stringify(day)} is not a YYYY-MM-DD day`);
      continue;
    }
    const byAgent = days[day];
    if (!byAgent || typeof byAgent !== "object" || Array.isArray(byAgent)) {
      fail(`${day} is not an object`);
      continue;
    }
    const agents = Object.entries(byAgent as Record<string, unknown>);
    if (agents.length > LIMITS.agentsPerDay) {
      fail(`${day} names ${agents.length} agents`);
      continue;
    }

    for (const [agent, models] of agents) {
      if (!SAFE_RE.test(agent)) {
        fail(`${day} has an unusable agent key`);
        continue;
      }
      if (!models || typeof models !== "object" || Array.isArray(models)) {
        fail(`${day}/${agent} is not an object`);
        continue;
      }
      const modelEntries = Object.entries(models as Record<string, unknown>);
      if (modelEntries.length > LIMITS.modelsPerAgent) {
        fail(`${day}/${agent} names ${modelEntries.length} models`);
        continue;
      }

      for (const [model, value] of modelEntries) {
        if (!SAFE_RE.test(model)) {
          fail(`${day}/${agent} has an unusable model key`);
          continue;
        }
        if (flat) {
          if (!validBucket(value)) fail(`${day}/${agent}/${model} is not a valid bucket`);
          continue;
        }
        checkCell(value, `${day}/${agent}/${model}`, fail);
      }
    }
  }
}

function checkCell(value: unknown, where: string, fail: (msg: string) => void): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${where} is not a cell object`);
    return;
  }
  const cell = value as Record<string, unknown>;

  const s = cell["s"];
  if (s !== undefined) {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      fail(`${where}.s is not an object`);
    } else {
      const entries = Object.entries(s as Record<string, unknown>);
      if (entries.length > LIMITS.sourcesPerCell) {
        fail(`${where} names ${entries.length} sources`);
      } else {
        for (const [digest, b] of entries) {
          if (!DIGEST_RE.test(digest)) fail(`${where} has a malformed source key`);
          else if (!validBucket(b)) fail(`${where} has an invalid bucket`);
        }
      }
    }
  }

  const u = cell["u"];
  if (u !== undefined) {
    if (!u || typeof u !== "object" || Array.isArray(u)) {
      fail(`${where}.u is not an object`);
    } else {
      const entries = Object.entries(u as Record<string, unknown>);
      if (entries.length > LIMITS.originsPerCell) {
        fail(`${where} names ${entries.length} origins`);
      } else {
        for (const [origin, b] of entries) {
          if (!SAFE_RE.test(origin)) fail(`${where} has an unusable origin key`);
          else if (!validBucket(b)) fail(`${where} has an invalid bucket`);
        }
      }
    }
  }

  if (s === undefined && u === undefined) fail(`${where} carries neither sources nor origins`);
}

const validBucket = (b: unknown): b is Bucket =>
  isBucket(b) && b.every((n) => Number.isInteger(n) && n <= LIMITS.tokens);

/* ------------------------------------------------------------------ *
 * Merge
 * ------------------------------------------------------------------ */

export type ImportPreview = {
  from: { origin: string; tz: string; exportedAt: string; since: string };
  /** The exporting ledger is this machine's own lineage — a re-import, or a copied config. */
  sameOrigin: boolean;
  localTz: string;
  before: { days: number; tokens: number };
  after: { days: number; tokens: number };
  /** New sessions, sessions whose reading grew, sessions already held unchanged. */
  sources: { incoming: number; added: number; raised: number; unchanged: number };
  newDayCount: number;
  /** A sample, for printing. `newDayCount` is the real figure. */
  newDays: string[];
  /** Sessions the exporting machine filed under a different calendar day. See the tz note. */
  relocated: number;
  /** History held but deliberately not added to the totals, with the reason stated. */
  notCounted: ForeignHistory[];
  /**
   * Tokens held aside before and after the merge.
   *
   * Carried because an import can be worth applying while changing no total at all: a machine
   * whose history has no session identities contributes nothing countable, and storing it is
   * still the difference between keeping that history and dropping it on the floor.
   */
  held: { before: number; after: number };
  warnings: string[];
  changed: boolean;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const maxInto = (
  into: Record<string, Bucket>,
  k: string,
  b: Bucket,
): "added" | "raised" | "unchanged" => {
  const seen = into[k];
  if (!seen) {
    into[k] = b;
    return "added";
  }
  if (sum(b) > sum(seen)) {
    into[k] = b;
    return "raised";
  }
  return "unchanged";
};

/**
 * Merge an export into a ledger and describe what changed. Pure — neither input is mutated.
 *
 * The only subtlety is *relocation*. A source digest identifies one session globally, so the
 * same digest appearing under a different `(day, agent, model)` than this machine already
 * holds is not a second session — it is the same session the exporting machine filed under a
 * different local day, which is what a timezone difference looks like from here. Counting it
 * in both places would double it. It is therefore merged into the coordinate this machine
 * already has, and reported: the tokens are right, the day is ours.
 */
export function mergeExport(
  live: Ledger,
  inc: LedgerExport,
): { ledger: Ledger; preview: ImportPreview } {
  const next = clone(live);
  const before = ledgerSummary(live);

  /** Where this machine already files each known session. */
  const home = new Map<string, { day: string; agent: string; model: string }>();
  for (const [day, byAgent] of Object.entries(live.days)) {
    for (const [agent, models] of Object.entries(byAgent ?? {})) {
      for (const [model, cell] of Object.entries(models ?? {})) {
        for (const digest of Object.keys(cell?.s ?? {})) home.set(digest, { day, agent, model });
      }
    }
  }

  const counts = { incoming: 0, added: 0, raised: 0, unchanged: 0 };
  let relocated = 0;
  const warnings: string[] = [];

  const cellAt = (day: string, agent: string, model: string): Cell => {
    const c = (((next.days[day] ??= {})[agent] ??= {})[model] ??= { s: {} });
    c.s ??= {};
    return c;
  };

  for (const [day, byAgent] of Object.entries(inc.days ?? {})) {
    for (const [agent, models] of Object.entries(byAgent ?? {})) {
      for (const [model, cell] of Object.entries(models ?? {})) {
        for (const [digest, b] of Object.entries(cell?.s ?? {})) {
          if (!isBucket(b)) continue;
          counts.incoming += 1;

          const at = home.get(digest) ?? { day, agent, model };
          if (at.day !== day || at.agent !== agent || at.model !== model) relocated += 1;

          const outcome = maxInto(cellAt(at.day, at.agent, at.model).s, digest, b);
          counts[outcome] += 1;
          home.set(digest, at);
        }

        /* An unidentified floor is stored under the origin that could not identify it, whoever
           that is. Ours is a floor under our own total; a foreign one is held and reported and
           never counted. Either way it stays on the coordinate the export gave it — there is
           no identity to relocate it by. */
        for (const [origin, b] of Object.entries(cell?.u ?? {})) {
          if (!isBucket(b)) continue;
          const target = cellAt(day, agent, model);
          maxInto((target.u ??= {}), origin, b);
        }
      }
    }
  }

  const after = ledgerSummary(next);

  const liveDays = new Set<string>();
  for (const cell of localCells(live)) liveDays.add(cell.day);
  const newDays = new Set<string>();
  for (const cell of localCells(next)) if (!liveDays.has(cell.day)) newDays.add(cell.day);

  if (inc.tz !== live.tz) {
    warnings.push(
      `days were binned in ${inc.tz}; this machine uses ${live.tz}. Totals are unaffected — ` +
        "every session is still counted once — but work near midnight may sit on the adjacent " +
        "day. The ledger keeps no clock, so nothing can be re-binned after the fact.",
    );
  }
  if (relocated > 0) {
    warnings.push(
      `${relocated} ${relocated === 1 ? "session was" : "sessions were"} filed under a different ` +
        "calendar day there. Each is counted once, on the day this machine already had it.",
    );
  }
  if (inc.origin === live.origin) {
    warnings.push(
      "this export came from this machine's own ledger lineage, so nothing in it is treated as " +
        "independent work.",
    );
  }

  const heldBefore = foreignHistory(live).reduce((a, f) => a + f.tokens, 0);
  const notCounted = foreignHistory(next);
  const heldAfter = notCounted.reduce((a, f) => a + f.tokens, 0);
  if (notCounted.length > 0) {
    warnings.push(
      `${notCounted.length} ${notCounted.length === 1 ? "machine's" : "machines'"} history carries ` +
        "no session identities and is kept aside rather than added: nothing in an aggregate " +
        "distinguishes independent work from a copy of work already counted.",
    );
  }

  const sortedNew = [...newDays].sort();
  return {
    ledger: next,
    preview: {
      from: { origin: inc.origin, tz: inc.tz, exportedAt: inc.exportedAt, since: inc.since },
      sameOrigin: inc.origin === live.origin,
      localTz: live.tz,
      before: { days: before.days, tokens: before.tokens },
      after: { days: after.days, tokens: after.tokens },
      sources: counts,
      newDayCount: sortedNew.length,
      newDays: sortedNew.slice(0, 10),
      relocated,
      notCounted,
      held: { before: heldBefore, after: heldAfter },
      warnings,
      /* Held history counts as a change even though it moves no total. Gating the write on
         the totals alone meant importing a machine whose history has no session identities
         reported "nothing to do" and then stored nothing — which is discarding it, quietly,
         which is the one thing this design promised not to do. */
      changed:
        after.tokens !== before.tokens ||
        after.days !== before.days ||
        counts.added > 0 ||
        counts.raised > 0 ||
        heldAfter !== heldBefore,
    },
  };
}
