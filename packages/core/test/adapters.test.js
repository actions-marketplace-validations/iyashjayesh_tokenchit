import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createClaudeCode, createCodex } from "../dist/adapters/index.js";
import { aggregate } from "../dist/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const collect = async (adapter) => {
  const out = [];
  for await (const e of adapter.read()) out.push(e);
  return out;
};

test("claude: deduplicates messages replayed across session files", async () => {
  const events = await collect(createClaudeCode(join(FIXTURES, "claude")));

  // proj-b replays msg_1 verbatim (a resumed session) and repeats msg_2 as a sidechain.
  // Both must collapse; msg_9 is genuinely new. <synthetic> is dropped outright.
  assert.deepEqual(
    events.map((e) => e.model).sort(),
    ["claude-opus-5", "claude-opus-5", "claude-opus-5", "totally-made-up-model"],
  );
  assert.equal(events.length, 4);
});

test("claude: counts all four token buckets", async () => {
  const events = await collect(createClaudeCode(join(FIXTURES, "claude")));
  const first = events.find((e) => e.input === 100);

  assert.deepEqual(
    { i: first.input, o: first.output, w: first.cacheWrite, r: first.cacheRead },
    { i: 100, o: 50, w: 200, r: 400 },
  );
});

test("claude: survives a truncated final line", async () => {
  // A live session's last line is often half-flushed. Nothing should throw.
  const events = await collect(createClaudeCode(join(FIXTURES, "claude")));
  assert.ok(events.length > 0);
});

test("codex: reports a file's growth, never the sum of its readings", async () => {
  const events = await collect(createCodex(join(FIXTURES, "codex")));

  assert.equal(events.length, 1, "one event per session file");
  const [e] = events;

  // The counter runs 1100 -> 3300. Summing the readings would give 4400; taking the last
  // would give 3300 and, in a resumed session, would count everything the previous session
  // did all over again. The growth is 2200.
  //
  // The cost of this is the first turn of a fresh session, measured at 0.42% across a real
  // corpus — against the alternative of counting an inherited total once per resume, which
  // compounds without limit.
  assert.equal(e.input + e.output + e.cacheRead + e.cacheWrite, 2200);
  // cached_input_tokens is a subset of input_tokens, so the buckets stay disjoint.
  assert.equal(e.input, 1200);
  assert.equal(e.cacheRead, 800);
  assert.equal(e.output, 200);
  assert.equal(e.model, "gpt-5.5", "model comes from turn_context, not session_meta");
});

test("codex: ignores rate-limit heartbeats with null info", async () => {
  const events = await collect(createCodex(join(FIXTURES, "codex")));
  assert.equal(events.length, 1);
});

test("unpriced models count tokens but are excluded from cost", async () => {
  const stats = await aggregate(createClaudeCode(join(FIXTURES, "claude")).read());

  const madeUp = stats.models.find((m) => m.model === "totally-made-up-model");
  assert.equal(madeUp.priced, false);
  assert.equal(madeUp.tokens, 2000);
  assert.equal(madeUp.equivCostUsd, 0);

  assert.ok(stats.tokens > 2000, "its tokens are still in the total");
  assert.ok(stats.pricedShare > 0 && stats.pricedShare < 1);
});

test("a resumed codex session contributes its growth, not the total it inherited", async () => {
  // Codex reports a running total. A fresh rollout's first token_count already reflects its
  // first turn (~20-30k on real sessions), but a resumed one starts at whatever the previous
  // session reached — and taking the final reading counts all of that again. Every resume
  // compounds, which is what a chain of 42M, 2.8B, 24.6B, 42.4B codex days looks like from
  // outside: a counter accumulating, not a person working harder each day.
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = await mkdtemp(join(tmpdir(), "tokenchit-codex-"));
  const dir = join(root, "2026", "09", "01");
  await mkdir(dir, { recursive: true });

  const turn = (total, cached, out, ts) =>
    JSON.stringify({
      timestamp: ts,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: total - out,
            cached_input_tokens: cached,
            output_tokens: out,
            total_tokens: total,
          },
        },
      },
    });

  // Inherits 20,000,000,000 and grows by 1,000,000 over the session.
  await writeFile(
    join(dir, "rollout-2026-09-01T10-00-00-resumed.jsonl"),
    [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      turn(20_000_000_000, 19_000_000_000, 8_000_000_000, "2026-09-01T10:00:00Z"),
      turn(20_001_000_000, 19_000_400_000, 8_000_600_000, "2026-09-01T10:30:00Z"),
    ].join("\n"),
  );

  const { createCodex } = await import("../dist/adapters/codex.js");
  const events = [];
  for await (const e of createCodex(root).read()) events.push(e);

  assert.equal(events.length, 1, "one event per rollout file");
  const total = events[0].input + events[0].output + events[0].cacheRead + events[0].cacheWrite;
  assert.equal(total, 1_000_000, "only the million it grew by, not the twenty billion it began with");
});

test("one unreadable transcript does not abort the scan", async (t) => {
  /*
   * A corrupt line was already tolerated; an unreadable file was not. `createReadStream` defers
   * the open, so EACCES arrived on first read, threw out of the adapter's generator and took the
   * whole scan with it — every other transcript and every other agent discarded, no card, exit
   * 1. A root-owned transcript left behind by one `sudo` run is enough to cause it. Reproduced
   * against the built CLI before the fix.
   */
  const { mkdtemp, mkdir, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readAll } = await import("@tokenchit/core/adapters");
  const { aggregate } = await import("@tokenchit/core");

  const home = await mkdtemp(join(tmpdir(), "tokenchit-eacces-"));
  const dir = join(home, ".claude", "projects", "p");
  await mkdir(dir, { recursive: true });

  const row = (id, n) =>
    JSON.stringify({
      type: "assistant",
      requestId: `req_${id}`,
      timestamp: new Date(Date.UTC(2026, 7, 1, 12)).toISOString(),
      message: {
        id: `msg_${id}`,
        role: "assistant",
        model: "claude-opus-5",
        usage: { input_tokens: n, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });

  await writeFile(join(dir, "readable.jsonl"), row("a", 100) + "\n");
  await writeFile(join(dir, "locked.jsonl"), row("b", 500) + "\n");
  await chmod(join(dir, "locked.jsonl"), 0o000);

  // Running as root would read it anyway and prove nothing.
  if (process.getuid && process.getuid() === 0) return t.skip("running as root");

  /* HOME as well as CLAUDE_CONFIG_DIR: the adapter resolves several roots, so setting only the
     latter left the real machine's profiles in scope and the assertion read the whole corpus. */
  const prev = {
    cfg: process.env["CLAUDE_CONFIG_DIR"],
    home: process.env["HOME"],
    up: process.env["USERPROFILE"],
  };
  process.env["CLAUDE_CONFIG_DIR"] = join(home, ".claude");
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  try {
    const stats = await aggregate(readAll(["claude-code"]));
    assert.equal(stats.tokens, 100, "the readable transcript survives the unreadable one");
  } finally {
    for (const [k, v] of [
      ["CLAUDE_CONFIG_DIR", prev.cfg],
      ["HOME", prev.home],
      ["USERPROFILE", prev.up],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await chmod(join(dir, "locked.jsonl"), 0o644).catch(() => {});
  }
});

/* ------------------------------------------------------------------ *
 * Log files are untrusted input
 * ------------------------------------------------------------------ */

/**
 * A transcript is written by somebody else's software, truncated by crashes and occasionally
 * corrupt, and whatever is read out of one flows into the card, the published payload and the
 * ledger — where max-wins banks it permanently. These are the values that got through before
 * the boundary coercions existed.
 */
test("a corrupt transcript cannot produce a corrupt total", async () => {
  const { aggregate: agg } = await import("../dist/index.js");
  const root = join(FIXTURES, "corrupt");
  const events = await collect(createClaudeCode(root));

  for (const e of events) {
    for (const field of ["input", "output", "cacheWrite", "cacheRead"]) {
      const n = e[field];
      assert.equal(typeof n, "number", `${field} is not a number`);
      assert.ok(Number.isFinite(n), `${field} is not finite`);
      assert.ok(Number.isInteger(n), `${field} is not an integer`);
      assert.ok(n >= 0, `${field} is negative`);
    }
    // A six-digit year renders as "275760-09-13", which is not a day this tool can read back.
    assert.ok(e.ts.getFullYear() >= 2000 && e.ts.getFullYear() <= 9999, "implausible year");
  }

  const stats = await agg(createClaudeCode(root).read());
  assert.equal(typeof stats.tokens, "number");
  assert.ok(Number.isFinite(stats.tokens), "a string count concatenated into the total");
  assert.ok(Number.isFinite(stats.equivCostUsd));

  // The one sound line in the fixture still counts: rejecting a bad value must not cost a
  // user the rest of the file.
  assert.ok(stats.tokens >= 110, `the sound line was dropped too (got ${stats.tokens})`);
});

test("a ledger built from any transcript can always be exported", async () => {
  /*
   * A round-trip property rather than an example. One corrupt timestamp used to make the whole
   * history un-exportable — the feature worked, the data was fine, and a single bad line from
   * months ago silently disabled it.
   */
  const { buildExport, emptyLedger, ledgerSummary, recordAndReplay, validateExport } = await import(
    "../dist/adapters/index.js"
  );

  const ledger = emptyLedger();
  const source = createClaudeCode(join(FIXTURES, "corrupt"));
  for await (const _ of recordAndReplay(source.read(), ledger, ["claude-code"], undefined, [])) {
    // drained for the banking side effect
  }

  const checked = validateExport(JSON.parse(JSON.stringify(buildExport(ledger))));
  assert.equal(checked.ok, true, `export rejected: ${checked.ok ? "" : checked.errors.join("; ")}`);
  assert.ok(Number.isFinite(ledgerSummary(ledger).tokens));
  for (const day of Object.keys(ledger.days)) {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/, `banked an unreadable day key: ${day}`);
  }
});
