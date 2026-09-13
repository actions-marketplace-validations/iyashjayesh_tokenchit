/**
 * The shape every adapter normalises to. One event is one billable exchange, except for
 * Codex, which only records running totals — see `adapters/codex.ts`.
 */
export type UsageEvent = {
  agent: AgentId;
  /** When the exchange happened. Bucketed by *local* date downstream. */
  ts: Date;
  /** Provider's model id, verbatim. May be unknown to the price table. */
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /**
   * How much of `ts` is a real observation. Absent means `exact`, so every existing producer
   * keeps its meaning and every existing consumer keeps its behaviour.
   *
   * Three quite different things were flowing through one `Date` and being counted as the
   * same kind of evidence:
   *
   * - `exact`   — the provider stamped this exchange. Claude Code and OpenCode.
   * - `session` — real, but one stamp for a whole session's growth. Codex reports a running
   *               counter, so a rollout contributes a single event dated at its last turn:
   *               the day is right, the hour is only the hour it finished.
   * - `day`     — the date is real and the clock is invented. Ledger replay stores a day and
   *               synthesises local noon to put it back.
   *
   * Totals, streaks, windows and the sparkline do not care. Anything reading the *hour* does,
   * which is what `clockTokens` in `Stats` is for: a question about when somebody works must
   * not be answered with a timestamp this tool made up.
   */
  tsPrecision?: TsPrecision;
  /**
   * The agent's own identifier for the session this exchange belongs to, verbatim.
   *
   * Not for display and not for counting — for *merging*. A day total carries no evidence for
   * whether two machines saw the same work or different work, and a machine identifier is not
   * evidence either, because people copy home directories. A session id is: the agent minted
   * it, it travels with the data rather than with the device, and two machines that both hold
   * it are holding one piece of work twice.
   *
   * The ledger stores a truncated digest of this rather than the value, and never the file it
   * was read from. See `ledger.ts` and `portable.ts`.
   *
   * Optional, because an adapter that cannot attribute a record must say so rather than
   * invent an identity — usage with no source is banked separately and never merged across
   * machines, which is the conservative answer to "we do not know".
   */
  sourceId?: string;
};

export type TsPrecision = "exact" | "session" | "day";

/** Absent is `exact`: an adapter that does not say is taken at its word. */
export const precisionOf = (e: UsageEvent): TsPrecision => e.tsPrecision ?? "exact";

/**
 * Whether this event's clock time was observed rather than synthesised.
 *
 * `session` counts as real here. Codex genuinely saw that moment; it is coarse, not invented,
 * and excluding it would discard the only timing evidence a Codex-only user has.
 */
export const hasRealClock = (e: UsageEvent): boolean => precisionOf(e) !== "day";

export type AgentId = "claude-code" | "codex" | "opencode" | "gemini";

/**
 * `installed-no-data` is a real, common state, not an error.
 *
 * Copilot CLI keeps a live context gauge and never a cumulative total. Gemini CLI is the
 * subtler case: it records counts only in recent versions, so an installation whose sessions
 * all predate that is genuinely installed and genuinely uncountable. A user deserves to be
 * told why an agent contributes nothing rather than left wondering whether detection failed.
 */
export type Detection = "ready" | "installed-no-data" | "absent";

export type Adapter = {
  id: AgentId;
  /** Display name, as it appears on the card and in `tokenchit init`. */
  name: string;
  /** Where this adapter reads from, shown by `init` so nothing is hidden. */
  source: string;
  detect(): Promise<Detection>;
  read(): AsyncIterable<UsageEvent>;
};

/**
 * A token count read from a log file, or zero.
 *
 * Log files are untrusted input. They are written by other people's software, truncated by
 * crashes, and occasionally corrupt — and a value read out of one flows straight into the
 * card, the published payload and the ledger, where max-wins banks it *permanently*.
 *
 * Measured on a deliberately corrupt transcript before this existed: a string where a number
 * belonged turned `stats.tokens` into the concatenation `"110-99999lots00Infinity5311"` and
 * printed it as the card's headline, while a `1e308` made `ledgerSummary` return `Infinity`.
 * Neither was rejected anywhere downstream, because every downstream check assumes the
 * adapters produce numbers.
 *
 * So the coercion happens once, here, at the boundary where the value stops being JSON and
 * starts being a measurement:
 *
 * - not a finite number, negative, or above `MAX_SAFE_INTEGER` — where integer arithmetic
 *   stops being exact anyway — reads as 0 rather than propagating;
 * - a fractional value is floored, because a token is a whole thing and the export format
 *   validates buckets as integers.
 *
 * Zero rather than throwing: one bad line must not cost a user every other line in the file.
 */
export const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER
    ? Math.floor(v)
    : 0;

/**
 * A timestamp read from a log file, or null.
 *
 * The companion to `count`, and it exists for a failure that is easy to miss. Every adapter
 * already rejected an unparseable date — but not an absurd one, and `localDay` renders a
 * six-digit year as `275760-09-13`. That is a day key the ledger accepts and the export format
 * rejects, so a *single* corrupt timestamp anywhere in a corpus made the whole history
 * un-exportable: the feature works, the data is fine, and one bad line from years ago silently
 * disables it.
 *
 * Bounded at four digits rather than at "now", deliberately. Rejecting future dates would mean
 * a machine with a wrong clock loses real work, which is a worse failure than keeping a date
 * that is merely implausible. The job here is only to guarantee that every day key this tool
 * produces is a `YYYY-MM-DD` it can also read back.
 */
export const when = (raw: unknown): Date | null => {
  if (raw === undefined || raw === null) return null;
  const d = raw instanceof Date ? raw : new Date(raw as string | number);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  return year >= 2000 && year <= 9999 ? d : null;
};

export const totalTokens = (e: UsageEvent): number =>
  e.input + e.output + e.cacheWrite + e.cacheRead;
