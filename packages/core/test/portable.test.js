import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ACCOUNTING_VERSION,
  bank,
  buildExport,
  commitLedger,
  emptyLedger,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  foreignHistory,
  ledgerSummary,
  LIMITS,
  mergeExport,
  readLedger,
  recordAndReplay,
  sourceDigest,
  validateExport,
  withLedgerLock,
  writeLedger,
} from "../dist/adapters/index.js";

/**
 * The ten acceptance cases for portable history, one test each.
 *
 * Every one of them is a question the old day-total ledger could not answer, so each test
 * states the wrong answer it is guarding against as well as the right one.
 */

/** A ledger with an origin we control, so "ours" and "theirs" are unambiguous in assertions. */
const ledgerFrom = (origin, tz = "UTC") => ({ ...emptyLedger(), origin, tz });

/** Bank one session's day total. */
const put = (led, day, session, tokens, agent = "claude-code", model = "opus") =>
  bank(led, day, agent, model, sourceDigest(agent, session), [tokens, 0, 0, 0]);

const exportOf = (led) => JSON.parse(JSON.stringify(buildExport(led)));

const tokensOf = (led) => ledgerSummary(led).tokens;

/* ---------------------------------------------------------------- *
 * 1. Repeated import
 * ---------------------------------------------------------------- */

test("importing the same file twice changes nothing the second time", () => {
  const theirs = ledgerFrom("them");
  put(theirs, "2026-08-01", "their-session-1", 1000);
  put(theirs, "2026-08-02", "their-session-2", 2000);

  const mine = ledgerFrom("me");
  put(mine, "2026-08-01", "my-session-1", 500);

  const first = mergeExport(mine, exportOf(theirs));
  assert.equal(tokensOf(first.ledger), 3500, "500 of mine plus 3000 of theirs");
  assert.equal(first.preview.sources.added, 2);
  assert.ok(first.preview.changed);

  const second = mergeExport(first.ledger, exportOf(theirs));
  assert.equal(tokensOf(second.ledger), 3500, "a repeat import adds nothing");
  assert.equal(second.preview.sources.added, 0);
  assert.equal(second.preview.sources.unchanged, 2);
  assert.equal(second.preview.changed, false, "and says so rather than reporting a no-op merge");

  // Idempotence is structural, not a deduplication pass: the trees are identical.
  assert.deepEqual(second.ledger.days, first.ledger.days);
});

/* ---------------------------------------------------------------- *
 * 2. Independent machines on overlapping dates
 * ---------------------------------------------------------------- */

test("two machines working the same day add up", () => {
  const day = "2026-08-01";

  const laptop = ledgerFrom("laptop");
  put(laptop, day, "laptop-a", 1_000_000);

  const desktop = ledgerFrom("desktop");
  put(desktop, day, "desktop-a", 1_000_000);

  const { ledger, preview } = mergeExport(laptop, exportOf(desktop));

  assert.equal(
    tokensOf(ledger),
    2_000_000,
    "distinct sessions on one day are distinct work — a per-day maximum would report half of it",
  );
  assert.equal(preview.sources.added, 1);
  assert.equal(preview.newDayCount, 0, "the day itself is not new, only the work on it");
});

/* ---------------------------------------------------------------- *
 * 3. Copied logs / a copied home directory
 * ---------------------------------------------------------------- */

test("the same sessions arriving from a second machine are not counted twice", () => {
  const day = "2026-08-01";

  const original = ledgerFrom("original");
  put(original, day, "session-a", 700);
  put(original, day, "session-b", 300);

  /* Someone copied ~/.claude to a second machine and ran tokenchit there. Different origin,
     different ledger file, *identical* sessions — which is exactly the case a machine id
     cannot detect and addition would double. */
  const copy = ledgerFrom("copy");
  put(copy, day, "session-a", 700);
  put(copy, day, "session-b", 300);

  const { ledger, preview } = mergeExport(original, exportOf(copy));

  assert.equal(tokensOf(ledger), 1000, "one day's work, counted once");
  assert.equal(preview.sources.added, 0);
  assert.equal(preview.sources.unchanged, 2);
});

/* ---------------------------------------------------------------- *
 * 4. Device migration
 * ---------------------------------------------------------------- */

test("migrating to a new machine keeps the history and does not inflate it", () => {
  const old = ledgerFrom("old-laptop");
  put(old, "2026-07-01", "s1", 1000);
  put(old, "2026-07-02", "s2", 2000);
  put(old, "2026-07-03", "s3", 3000);

  /* The new machine has the copied logs, so it has re-derived the same sessions locally, and
     then the user imports the old ledger too. Both routes carry the same identities. */
  const fresh = ledgerFrom("new-laptop");
  put(fresh, "2026-07-02", "s2", 2000);
  put(fresh, "2026-07-03", "s3", 3000);

  const { ledger, preview } = mergeExport(fresh, exportOf(old));

  assert.equal(tokensOf(ledger), 6000, "nothing doubled");
  assert.equal(preview.sources.added, 1, "only the day whose transcripts had already rotated");
  assert.equal(preview.newDayCount, 1);
  assert.deepEqual(preview.newDays, ["2026-07-01"]);
});

/* ---------------------------------------------------------------- *
 * 5. Corrected records
 * ---------------------------------------------------------------- */

test("a fuller reading of a session replaces a thinner one, and never adds to it", () => {
  const day = "2026-08-01";

  const thin = ledgerFrom("me");
  put(thin, day, "s1", 400); // read mid-session, before the transcript was complete

  const full = ledgerFrom("them");
  put(full, day, "s1", 900); // the same session, read after it finished

  const up = mergeExport(thin, exportOf(full));
  assert.equal(tokensOf(up.ledger), 900, "raised to the fuller reading, not 1300");
  assert.equal(up.preview.sources.raised, 1);
  assert.equal(up.preview.sources.added, 0);

  // And the other direction is inert, so import order cannot change the answer.
  const down = mergeExport(up.ledger, exportOf(thin));
  assert.equal(tokensOf(down.ledger), 900, "a thinner reading never lowers a banked session");
  assert.equal(down.preview.changed, false);
});

/* ---------------------------------------------------------------- *
 * 6. Interrupted import
 * ---------------------------------------------------------------- */

test("an import that dies mid-merge leaves the live ledger untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenchit-portable-"));
  const path = join(dir, "ledger.json");

  const mine = ledgerFrom("me");
  put(mine, "2026-08-01", "s1", 1000);
  await writeLedger(mine, path);
  const before = await readFile(path, "utf8");

  // The merge is pure and the write is the last step, so a failure before the rename cannot
  // have touched the file. Simulated by throwing inside the lock, where an apply does its work.
  await assert.rejects(
    withLedgerLock(path, async () => {
      const live = await readLedger(path);
      mergeExport(live, exportOf(ledgerFrom("them")));
      throw new Error("killed");
    }),
    /killed/,
  );

  assert.equal(await readFile(path, "utf8"), before, "byte-for-byte unchanged");
  assert.equal(tokensOf(await readLedger(path)), 1000);

  // The lock is released even on the failure path, or every later run would wedge.
  assert.equal(await withLedgerLock(path, async () => "free"), "free");
});

/* ---------------------------------------------------------------- *
 * 7. Concurrent scan
 * ---------------------------------------------------------------- */

test("a scan landing during an import is merged, not overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenchit-portable-"));
  const path = join(dir, "ledger.json");

  const live = ledgerFrom("me");
  put(live, "2026-08-01", "s1", 1000);
  await writeLedger(live, path);

  /*
   * The hazard this guards: a sync reads the bank, walks the logs for several seconds, then
   * writes. An import committing in that window used to be silently erased by the write-back.
   * `commitLedger` replays the scan's decisions against a *fresh* read instead.
   */
  const scanStarted = await readLedger(path); // what a long scan would still be holding
  assert.equal(tokensOf(scanStarted), 1000);

  // Meanwhile the import commits.
  const theirs = ledgerFrom("them");
  put(theirs, "2026-08-05", "their-s1", 5000);
  const imported = mergeExport(await readLedger(path), exportOf(theirs));
  await writeLedger(imported.ledger, path);

  // Now the slow scan finishes and commits what it found.
  const committed = await commitLedger(
    [
      {
        day: "2026-08-02",
        agent: "claude-code",
        model: "opus",
        source: sourceDigest("claude-code", "s2"),
        b: [2000, 0, 0, 0],
      },
    ],
    { path },
  );

  assert.equal(
    tokensOf(committed),
    8000,
    "the import's 5000, the scan's new 2000 and the original 1000 all survive",
  );
  assert.equal(tokensOf(await readLedger(path)), 8000, "and that is what is on disk");
});

test("the lock serialises two writers rather than letting them interleave", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenchit-portable-"));
  const path = join(dir, "ledger.json");
  await writeLedger(ledgerFrom("me"), path);

  /*
   * Mutual exclusion is the invariant, not arrival order.
   *
   * Which of two simultaneous `open(wx)` calls wins is up to the kernel and the event loop, so
   * asserting an order made this test flaky under load — it passed alone and failed inside the
   * full suite. What must always hold is that the two critical sections never overlap.
   */
  let inside = 0;
  let overlapped = false;
  const entries = [];

  const critical = (name, ms) =>
    withLedgerLock(path, async () => {
      entries.push(name);
      inside += 1;
      if (inside > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, ms));
      if (inside > 1) overlapped = true;
      inside -= 1;
    });

  await Promise.all([critical("a", 60), critical("b", 10), critical("c", 30)]);

  assert.equal(overlapped, false, "no two writers were ever inside the lock at once");
  assert.equal(entries.length, 3, "and all three got their turn rather than one being dropped");
  assert.equal(inside, 0, "the lock is released on the way out");
});

/* ---------------------------------------------------------------- *
 * 8. Incompatible export
 * ---------------------------------------------------------------- */

const sampleExport = () => {
  const l = ledgerFrom("them");
  put(l, "2026-08-01", "s1", 10);
  return exportOf(l);
};

test("an export this build cannot merge is refused, with a reason and a next step", () => {
  const good = sampleExport();
  assert.equal(validateExport(good).ok, true);

  const newerEnvelope = validateExport({ ...good, version: EXPORT_VERSION + 1 });
  assert.equal(newerEnvelope.ok, false);
  assert.match(newerEnvelope.errors.join(" "), /newer tokenchit/);
  assert.match(newerEnvelope.errors.join(" "), /Upgrade tokenchit/, "it names the fix");

  const otherAccounting = validateExport({ ...good, accounting: ACCOUNTING_VERSION + 1 });
  assert.equal(otherAccounting.ok, false);
  assert.match(otherAccounting.errors.join(" "), /accounting version/);

  assert.equal(validateExport({ ...good, format: "something-else" }).ok, false);
  assert.equal(validateExport("not an object").ok, false);
  assert.equal(validateExport(null).ok, false);
  assert.equal(validateExport([good]).ok, false, "an array is not an envelope");
});

test("a malformed or hostile export is rejected before anything is written", () => {
  const base = sampleExport();
  const bad = (days) => validateExport({ ...base, days });
  const cell = (b) => ({ "2026-08-01": { "claude-code": { opus: { s: { aaaaaa: b } } } } });

  assert.equal(bad({ "not-a-date": { "claude-code": { opus: { s: { aaaaaa: [1, 0, 0, 0] } } } } }).ok, false);
  assert.equal(bad({ "2026-08-01": { "claude-code": { opus: { s: { "NOT HEX": [1, 0, 0, 0] } } } } }).ok, false);
  assert.equal(bad(cell([1, 0, 0])).ok, false, "a three-field bucket is not a bucket");
  assert.equal(bad(cell([-1, 0, 0, 0])).ok, false, "negative tokens");
  assert.equal(bad(cell([1e18, 0, 0, 0])).ok, false, "a number that is not a token count");
  assert.equal(bad(cell([1.5, 0, 0, 0])).ok, false, "a fractional token count");
  assert.equal(bad(cell(["1", 0, 0, 0])).ok, false, "a string where a count belongs");
  assert.equal(bad({ "2026-08-01": { "claude-code": { opus: {} } } }).ok, false, "neither sources nor origins");
  assert.equal(bad({ "2026-08-01": { "claude-code": "opus" } }).ok, false, "a string where a tree belongs");
  assert.equal(bad({ "2026-08-01": [] }).ok, false, "an array where an object belongs");

  // A control character in a key would corrupt the NUL-separated internal key encoding.
  assert.equal(
    bad({ "2026-08-01": { "claude\u0000code": { opus: { s: { aaaaaa: [1, 0, 0, 0] } } } } }).ok,
    false,
  );

  // Width is bounded, so an import cannot be made arbitrarily large through one day.
  const wide = {};
  for (let i = 0; i < LIMITS.agentsPerDay + 1; i += 1) {
    wide[`agent-${i}`] = { opus: { s: { aaaaaa: [1, 0, 0, 0] } } };
  }
  assert.equal(bad({ "2026-08-01": wide }).ok, false);

  // And a rejection reports everything wrong at once rather than one problem per attempt.
  const many = validateExport({ ...base, origin: 5, since: "nope", days: { bad: {} } });
  assert.equal(many.ok, false);
  assert.ok(many.errors.length >= 2);
});

/* ---------------------------------------------------------------- *
 * 9. Timezone change
 * ---------------------------------------------------------------- */

test("a session filed under a different local day is counted once, on ours", () => {
  /*
   * The exporting machine is in Tokyo and we are in London. A late-evening session there is
   * the same afternoon session here, and the two ledgers bin it on different dates. Summing
   * both cells would double a session that only ever happened once.
   */
  const here = ledgerFrom("me", "Europe/London");
  put(here, "2026-08-01", "midnight-session", 5000);

  const there = ledgerFrom("them", "Asia/Tokyo");
  put(there, "2026-08-02", "midnight-session", 5000);

  const { ledger, preview } = mergeExport(here, exportOf(there));

  assert.equal(tokensOf(ledger), 5000, "one session, one count");
  assert.equal(preview.relocated, 1);
  assert.equal(ledgerSummary(ledger).days, 1, "and it stays on the day this machine had it");
  assert.match(preview.warnings.join(" "), /Asia\/Tokyo/, "the zone difference is stated");
  assert.match(preview.warnings.join(" "), /Europe\/London/);
  assert.match(preview.warnings.join(" "), /different calendar day/);

  // Totals are unaffected, which is the claim the warning makes; nothing is re-binned.
  assert.equal(preview.after.tokens, preview.before.tokens);
});

test("a same-zone import says nothing about timezones", () => {
  const here = ledgerFrom("me", "UTC");
  put(here, "2026-08-01", "s1", 10);
  const there = ledgerFrom("them", "UTC");
  put(there, "2026-08-01", "s2", 10);

  const { preview } = mergeExport(here, exportOf(there));
  assert.ok(!preview.warnings.some((w) => w.includes("binned")), "no warning where there is none");
  assert.equal(preview.relocated, 0);
});

/* ---------------------------------------------------------------- *
 * 10. A legacy ledger with no identity
 * ---------------------------------------------------------------- */

test("a version 1 ledger is migrated, keeps counting, and is never merged across machines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenchit-portable-"));
  const path = join(dir, "ledger.json");

  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      since: "2026-01-15",
      updatedAt: "2026-08-01T00:00:00.000Z",
      days: {
        "2026-07-01": { "claude-code": { opus: [1000, 0, 0, 0] } },
        "2026-07-02": { codex: { "gpt-5": [2000, 0, 0, 0] } },
      },
    }),
  );

  const migrated = await readLedger(path);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.since, "2026-01-15", "the install date survives");
  assert.equal(tokensOf(migrated), 3000, "and so does every token — the total must not drop");
  assert.equal(ledgerSummary(migrated).days, 2);
  assert.equal(foreignHistory(migrated).length, 0, "our own pre-identity history is ours");

  /*
   * Now somebody exports that migrated ledger and imports it on a second machine. The days
   * carry no session identities, so nothing in them can prove independence — they are kept as
   * an identified archive and reported, not added, and not discarded either.
   */
  const other = ledgerFrom("second-machine");
  put(other, "2026-07-05", "s1", 500);

  const { ledger, preview } = mergeExport(other, exportOf(migrated));

  assert.equal(
    tokensOf(ledger),
    500,
    "the legacy history is not summed into a machine that cannot verify it",
  );
  const held = foreignHistory(ledger);
  assert.equal(held.length, 1, "it is held");
  assert.equal(held[0].tokens, 3000, "in full");
  assert.equal(held[0].days, 2);
  assert.match(preview.warnings.join(" "), /no session identities/);
  assert.equal(preview.notCounted.length, 1);

  // And a second import of the same archive does not accumulate it.
  const again = mergeExport(ledger, exportOf(migrated));
  assert.equal(foreignHistory(again.ledger)[0].tokens, 3000);
  assert.equal(tokensOf(again.ledger), 500);
});

test("a migrated archive keeps a day the logs have since deleted", async () => {
  /* The whole reason the version 1 ledger existed. Migration must not quietly drop it, and a
     re-scan that can no longer see that day must still report it. */
  const dir = await mkdtemp(join(tmpdir(), "tokenchit-portable-"));
  const path = join(dir, "ledger.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      since: "2026-01-01",
      updatedAt: "2026-08-01T00:00:00.000Z",
      days: { "2026-06-01": { "claude-code": { opus: [9999, 0, 0, 0] } } },
    }),
  );

  const led = await readLedger(path);
  const replayed = [];
  // A scan that finds nothing at all on disk: the archive has to carry the day on its own.
  const nothing = (async function* () {})();
  for await (const e of recordAndReplay(nothing, led, ["claude-code"], undefined, [])) {
    replayed.push(e);
  }

  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].input, 9999);
  assert.equal(replayed[0].tsPrecision, "day", "the date is real and the clock is not");
});

/* ---------------------------------------------------------------- *
 * The export envelope itself
 * ---------------------------------------------------------------- */

test("an export carries usage and provenance, and nothing else", () => {
  const led = ledgerFrom("me", "Asia/Kolkata");
  put(led, "2026-08-01", "s1", 1234);

  const envelope = buildExport(led);

  assert.deepEqual(
    Object.keys(envelope).sort(),
    ["accounting", "coverage", "days", "exportedAt", "format", "origin", "since", "tz", "version"],
  );
  assert.equal(envelope.format, EXPORT_FORMAT);
  assert.equal(envelope.accounting, ACCOUNTING_VERSION);
  assert.equal(envelope.coverage.tokens, 1234);
  assert.equal(envelope.coverage.first, "2026-08-01");

  /*
   * The privacy contract, asserted rather than assumed. A session identity must appear only as
   * its digest — the raw id would let a reader match the file against the log filenames on the
   * exporting machine's disk, and a path of any kind is outside the contract entirely.
   */
  const text = JSON.stringify(envelope);
  assert.ok(!text.includes('"s1"'), "the raw session id does not travel");
  assert.ok(text.includes(sourceDigest("claude-code", "s1")), "its digest does");
  for (const forbidden of ["/Users/", "/home/", "auth", "avatar", "handle", "apiKey"]) {
    assert.ok(!text.includes(forbidden), `export leaked ${forbidden}`);
  }
});

test("exporting does not touch the ledger it reads", () => {
  const led = ledgerFrom("me");
  put(led, "2026-08-01", "s1", 10);
  const before = JSON.stringify(led);
  buildExport(led);
  assert.equal(JSON.stringify(led), before);
});

test("merging does not mutate either input", () => {
  const mine = ledgerFrom("me");
  put(mine, "2026-08-01", "s1", 10);
  const theirs = ledgerFrom("them");
  put(theirs, "2026-08-02", "s2", 20);

  const mineBefore = JSON.stringify(mine);
  const envelope = exportOf(theirs);
  const envelopeBefore = JSON.stringify(envelope);

  const { ledger } = mergeExport(mine, envelope);

  assert.equal(JSON.stringify(mine), mineBefore, "a preview must be able to run at any time");
  assert.equal(JSON.stringify(envelope), envelopeBefore);
  assert.equal(tokensOf(ledger), 30);
});

test("a round trip through the file format changes nothing", () => {
  const led = ledgerFrom("me", "Europe/Berlin");
  put(led, "2026-08-01", "s1", 1000);
  put(led, "2026-08-01", "s2", 2000, "codex", "gpt-5");
  put(led, "2026-08-02", "s3", 3000);

  const parsed = JSON.parse(JSON.stringify(buildExport(led)));
  const checked = validateExport(parsed);
  assert.equal(checked.ok, true);

  const { ledger, preview } = mergeExport(led, checked.value);
  assert.equal(tokensOf(ledger), 6000, "importing your own export is a no-op");
  assert.equal(preview.changed, false);
  assert.equal(preview.sameOrigin, true);
  assert.match(preview.warnings.join(" "), /own ledger lineage/);
});

/* ---------------------------------------------------------------- *
 * The rules themselves, stated directly
 * ---------------------------------------------------------------- */

test("max within a session, sum across sessions — and never the other way round", () => {
  const day = "2026-08-01";
  const mine = ledgerFrom("me");
  put(mine, day, "a", 100);
  put(mine, day, "b", 200);

  const theirs = ledgerFrom("them");
  put(theirs, day, "a", 150); // a fuller reading of one we have
  put(theirs, day, "c", 300); // work we have never seen

  const { ledger } = mergeExport(mine, exportOf(theirs));

  // 150 (raised, not 100+150) + 200 + 300
  assert.equal(tokensOf(ledger), 650);
});

test("unattributable usage from another machine is held, never added", () => {
  const day = "2026-08-01";
  const mine = ledgerFrom("me");
  put(mine, day, "a", 100);

  /* A machine whose adapter could not identify a record — an OpenCode blob with no session
     key, say. It is real usage, and it is also indistinguishable from a copy of ours. */
  const theirs = ledgerFrom("them");
  bank(theirs, day, "claude-code", "opus", null, [900, 0, 0, 0]);

  const { ledger, preview } = mergeExport(mine, exportOf(theirs));

  assert.equal(tokensOf(ledger), 100, "our total is unchanged");
  const held = foreignHistory(ledger);
  assert.equal(held.length, 1);
  assert.equal(held[0].tokens, 900, "and theirs is kept in full rather than discarded");
  assert.equal(preview.notCounted.length, 1);
});

test("our own unidentified reading is a floor, not an addend", () => {
  /*
   * The bug this rule exists for, reproduced.
   *
   * On the machine this was written on, five OpenCode cells were banked without identity and
   * then again *with* it, once the adapter learned that OpenCode keeps its session id in a
   * table column rather than in the JSON blob. Treating the two as complementary reported
   * 35.2M for 17.6M of work. They are two readings of the same logs, so the larger wins.
   */
  const day = "2026-08-01";
  const mine = ledgerFrom("me");
  bank(mine, day, "opencode", "qwen", null, [17_600_000, 0, 0, 0]); // the first, blind scan
  assert.equal(tokensOf(mine), 17_600_000);

  put(mine, day, "the-same-session", 17_600_000, "opencode", "qwen"); // the same work, now named
  assert.equal(tokensOf(mine), 17_600_000, "identified reading overtakes the floor, never adds");

  // And the floor still holds the line when the logs behind the identified reading thin out.
  const thinned = ledgerFrom("me2");
  bank(thinned, day, "opencode", "qwen", null, [17_600_000, 0, 0, 0]);
  put(thinned, day, "partial", 900, "opencode", "qwen");
  assert.equal(tokensOf(thinned), 17_600_000, "a half-rotated day is worth what it was");

  // A round trip through the file must not turn our own floor into a foreign one.
  const { ledger } = mergeExport(mine, exportOf(mine));
  assert.equal(tokensOf(ledger), 17_600_000);
  assert.equal(foreignHistory(ledger).length, 0);
});

test("a cell the adapter could only half identify keeps every token", async () => {
  /*
   * The case the floor would otherwise lose. If some of a cell's events carry a session and
   * some do not, banking only the unidentified *remainder* as the floor would let the max
   * report the identified part alone. `recordAndReplay` therefore files the whole cell's live
   * total as the floor whenever anything in it was unattributable.
   */
  const at = new Date(2026, 7, 1, 10, 0, 0);
  const ev = (tokens, sourceId) => ({
    agent: "claude-code",
    ts: at,
    model: "opus",
    input: tokens,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    ...(sourceId ? { sourceId } : {}),
  });

  const led = ledgerFrom("me");
  const ops = [];
  const events = (async function* () {
    yield ev(100, "known-session");
    yield ev(50, undefined); // an adapter that could not attribute this record
  })();
  for await (const _ of recordAndReplay(events, led, ["claude-code"], undefined, ops)) {
    // drained for its banking side effect
  }

  assert.equal(tokensOf(led), 150, "the floor covers the whole cell, so nothing is dropped");
  assert.equal(foreignHistory(led).length, 0, "and it is ours, so it counts");

  // Re-running the same scan is idempotent rather than cumulative.
  const again = [];
  const rerun = (async function* () {
    yield ev(100, "known-session");
    yield ev(50, undefined);
  })();
  for await (const _ of recordAndReplay(rerun, led, ["claude-code"], undefined, again)) {
    // drained
  }
  assert.equal(tokensOf(led), 150, "a second scan of the same logs changes nothing");
});
