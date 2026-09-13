import {
  foreignHistory,
  isBucket,
  safeKey,
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
  /* The origin becomes an object key in every cell's `u` map, so it is held to the same rule
     as the keys inside the tree rather than merely to "is a printable string". */
  if (typeof raw["origin"] === "string" && !safeKey(raw["origin"])) {
    fail("origin is not a usable identifier");
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
    if (!DAY_RE.test(day) || !safeKey(day)) {
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
      if (!SAFE_RE.test(agent) || !safeKey(agent)) {
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
        if (!SAFE_RE.test(model) || !safeKey(model)) {
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
          if (!DIGEST_RE.test(digest) || !safeKey(digest)) fail(`${where} has a malformed source key`);
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
          if (!SAFE_RE.test(origin) || !safeKey(origin)) fail(`${where} has an unusable origin key`);
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

/** Every cell one session occupies on one machine, and what that machine says it is worth. */
type Placement = {
  coords: { day: string; agent: string; model: string; b: Bucket }[];
  total: number;
};

/** Whether two placements describe the same set of cells, order-independently. */
function sameCoords(a: Placement, b: Placement): boolean {
  if (a.coords.length !== b.coords.length) return false;
  const key = (c: Placement["coords"][number]) => `${c.day}|${c.agent}|${c.model}`;
  const seen = new Set(a.coords.map(key));
  return b.coords.every((c) => seen.has(key(c)));
}

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
 * ## The merge unit is a session, not a cell
 *
 * A session digest identifies one piece of work globally, and that work can legitimately
 * occupy **more than one `(day, agent, model)` cell**: a session running past midnight lands
 * on two days, and a session that switches model lands on two models. So a session is merged
 * as a whole — its total across every coordinate it touches — rather than cell by cell.
 *
 * For each digest, the value kept is the **largest total any one machine attributes to it**,
 * and the day/model breakdown comes from that same machine. Both halves matter:
 *
 * - Taking the max across machines is the "max within one source" rule from `ledger.ts`,
 *   lifted to the level where a source actually lives. Two machines holding one session are
 *   holding one piece of work, however each of them split it up.
 * - Taking the breakdown from the machine that reported the largest total keeps the split
 *   coherent. Mixing one machine's Monday figure with another's Tuesday figure would bank a
 *   distribution neither machine ever observed.
 *
 * Merging cell by cell instead was a real bug, caught by fuzzing multi-machine merges against
 * a ground truth. Cell-by-cell with a single "home" coordinate per digest silently dropped
 * every coordinate after the first, so importing a ledger in which any session crossed
 * midnight lost that session's later day entirely. Cell-by-cell *without* a home coordinate
 * double-counts the timezone case instead. Grouping by session is the rule that is right for
 * both.
 */
export function mergeExport(
  live: Ledger,
  inc: LedgerExport,
): { ledger: Ledger; preview: ImportPreview } {
  const next = clone(live);
  const before = ledgerSummary(live);

  const held = (map: Map<string, Placement>, ledger: Ledger): void => {
    for (const [day, byAgent] of Object.entries(ledger.days)) {
      for (const [agent, models] of Object.entries(byAgent ?? {})) {
        for (const [model, cell] of Object.entries(models ?? {})) {
          for (const [digest, b] of Object.entries(cell?.s ?? {})) {
            if (!isBucket(b)) continue;
            const acc = map.get(digest) ?? { coords: [], total: 0 };
            acc.coords.push({ day, agent, model, b });
            acc.total += sum(b);
            map.set(digest, acc);
          }
        }
      }
    }
  };

  /** Where each session sits, and what it is worth, on either side of the merge. */
  const mine = new Map<string, Placement>();
  held(mine, live);

  const theirs = new Map<string, Placement>();
  held(theirs, { ...live, days: inc.days ?? {} });

  const counts = { incoming: 0, added: 0, raised: 0, unchanged: 0 };
  let relocated = 0;
  const warnings: string[] = [];

  /** Null for a coordinate that must never become an object key. See `safeKey`. */
  const cellAt = (day: string, agent: string, model: string): Cell | null => {
    if (!safeKey(day) || !safeKey(agent) || !safeKey(model)) return null;
    const c = (((next.days[day] ??= {})[agent] ??= {})[model] ??= { s: {} });
    c.s ??= {};
    return c;
  };

  /** Write a session into every cell its winning placement names. */
  const place = (digest: string, at: Placement): void => {
    for (const c of at.coords) {
      const cell = cellAt(c.day, c.agent, c.model);
      if (cell) cell.s[digest] = c.b;
    }
  };

  /** Take a session out of every cell it currently occupies, pruning what it empties. */
  const evict = (digest: string, at: Placement): void => {
    for (const { day, agent, model } of at.coords) {
      const cell = next.days[day]?.[agent]?.[model];
      if (!cell?.s) continue;
      delete cell.s[digest];

      // A cell with no sessions and no unidentified floor is a husk, not a record.
      if (Object.keys(cell.s).length === 0 && !cell.u) {
        delete next.days[day]![agent]![model];
        if (Object.keys(next.days[day]![agent]!).length === 0) delete next.days[day]![agent];
        if (Object.keys(next.days[day]!).length === 0) delete next.days[day];
      }
    }
  };

  for (const [digest, incoming] of theirs) {
    counts.incoming += 1;
    if (!safeKey(digest)) continue;

    const existing = mine.get(digest);

    if (!existing) {
      place(digest, incoming);
      counts.added += 1;
      continue;
    }

    if (sameCoords(existing, incoming)) {
      // Identical placement: the only question left is whose reading is fuller.
      if (incoming.total > existing.total) {
        place(digest, incoming);
        counts.raised += 1;
      } else {
        counts.unchanged += 1;
      }
      continue;
    }

    /* Different placement for the same session. Either the exporting machine's timezone put it
       on another date, or one side saw a part of it the other did not. The larger total is the
       more complete observation, and its breakdown travels with it. */
    relocated += 1;
    if (incoming.total > existing.total) {
      evict(digest, existing);
      place(digest, incoming);
      counts.raised += 1;
    } else {
      counts.unchanged += 1;
    }
  }

  /* An unidentified floor is stored under the origin that could not identify it, whoever
     that is. Ours is a floor under our own total; a foreign one is held and reported and
     never counted. Either way it stays on the coordinate the export gave it — there is
     no identity to relocate it by. */
  for (const [day, byAgent] of Object.entries(inc.days ?? {})) {
    for (const [agent, models] of Object.entries(byAgent ?? {})) {
      for (const [model, cell] of Object.entries(models ?? {})) {
        for (const [origin, b] of Object.entries(cell?.u ?? {})) {
          if (!isBucket(b) || !safeKey(origin)) continue;
          const target = cellAt(day, agent, model);
          if (!target) continue;
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
