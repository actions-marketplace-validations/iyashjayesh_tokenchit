import {
  commitLedger,
  readAll,
  readLedger,
  recordAndReplay,
  withoutAgents,
  type BankOp,
  type Ledger,
  type Recovered,
} from "@tokenchit/core/adapters";
import { aggregate, type AgentId, type Stats } from "@tokenchit/core";

export type Scan = {
  stats: Stats;
  /** Days the logs no longer covered in full, and what the bank put back. */
  recovered: Recovered;
  ledger: Ledger;
};

export type ScanOptions = {
  /**
   * Bank what this run saw. Off for `--dry-run`, which promises to write nothing — and the
   * ledger lives on disk like anything else, so writing it would break that promise. It also
   * keeps the privacy tests from depositing a ledger inside their fixture HOME.
   */
  write?: boolean;
  onProgress?: (p: { agent: string; events: number }) => void;
  /** Start from an empty bank. `ledger --rebuild` is the only caller. */
  fresh?: boolean;
  /** Report on one calendar year only. `recap --year` is the only caller. */
  year?: number;
};

/**
 * Read the logs, merge them with the ledger, and aggregate the result.
 *
 * The single place that turns "what is on this machine" into a Stats, so `sync`, `publish`
 * and `recap` cannot end up reporting different totals — which is the bug this project has
 * already fixed twice, and which a second call to `aggregate(readAll(...))` would reintroduce
 * the moment one of them forgot the ledger.
 *
 * Reading is unconditional and writing is not: a run always benefits from banked history,
 * but only a run that is allowed to touch the disk adds to it.
 */
export async function scan(agents: AgentId[], opts: ScanOptions = {}): Promise<Scan> {
  /* Scoped to the agents this run will actually re-derive. Clearing the whole bank here while
     `recordAndReplay` re-banks only `agents` destroyed every other agent's history — see
     `withoutAgents`. */
  const ledger = opts.fresh
    ? withoutAgents(await readLedger(), agents)
    : await readLedger();
  const recovered: Recovered = { days: 0, tokens: 0 };
  /* What this run decided to bank, kept so the commit can replay it against the ledger as it
     is *then* rather than writing back a copy that may be several seconds stale. A walk over
     a large corpus takes long enough for an import — or another shell's sync — to land in the
     middle of it, and the loser of that race used to be silently overwritten. */
  const ops: BankOp[] = [];

  /* The year filter belongs to the aggregation, not the read: the ledger must still bank
     every day it sees, or asking for one year's recap would prune the bank to that year. */
  const stats = await aggregate(
    recordAndReplay(readAll(agents, opts.onProgress), ledger, agents, recovered, ops),
    opts.year === undefined ? {} : { year: opts.year },
  );

  if (opts.write === false) return { stats, recovered, ledger };

  const committed = await commitLedger(ops, {
    /* A rebuild's clearing happens inside the lock too, against the fresh read, so it cannot
       be undone by a concurrent writer between the read above and the write below. */
    ...(opts.fresh ? (agents.length ? { clearAgents: agents } : { clearAll: true }) : {}),
  });
  /* The committed ledger is returned rather than the in-memory one: callers read `ledger.since`
     off it, and after a merge that is the merged file's value, not this run's copy. */
  return { stats, recovered, ledger: committed };
}
