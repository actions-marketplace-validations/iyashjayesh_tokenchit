import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { bucketsFor, createGemini } from "../dist/adapters/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "fixtures", "gemini");

const read = async () => {
  const out = [];
  for await (const e of createGemini(ROOT).read()) out.push(e);
  return out.sort((a, b) => a.ts - b.ts);
};

const total = (e) => e.input + e.output + e.cacheWrite + e.cacheRead;

/* ---------------------------------------------------------------------------
   The accounting. `cached` is inside `input`, which is the whole trap.
   --------------------------------------------------------------------------- */

test("cached is treated as a subset of input, not as a sixth bucket", () => {
  // Measured against real recordings: total === input + output + thoughts + tool.
  const b = bucketsFor({ input: 4200, output: 600, cached: 4200, thoughts: 200, tool: 0, total: 5000 });

  assert.equal(b.input, 0, "every input token on this turn was a cache read");
  assert.equal(b.cacheRead, 4200);
  assert.equal(b.output, 800, "thoughts and tool are generated tokens");
  assert.equal(b.cacheWrite, 0, "Gemini reports no cache-write figure");

  const naive = 4200 + 600 + 4200 + 200 + 0;
  assert.equal(b.input + b.output + b.cacheWrite + b.cacheRead, 5000, "matches the reported total");
  assert.equal(naive, 9200, "summing all five fields would have inflated this turn by 84%");
});

test("an uncached turn sums the same way, which is why one sample proves nothing", () => {
  // On a zero-cache record the wrong model and the right model agree. That is the trap.
  const t = { input: 1000, output: 100, cached: 0, thoughts: 50, tool: 0, total: 1150 };
  const b = bucketsFor(t);

  assert.equal(b.input + b.output + b.cacheWrite + b.cacheRead, 1150);
  assert.equal(t.input + t.output + t.cached + t.thoughts + t.tool, 1150, "both readings agree here");
});

test("a record whose components contradict its own total is skipped, never coerced", () => {
  assert.equal(
    bucketsFor({ input: 900, output: 100, cached: 0, thoughts: 0, tool: 0, total: 12345 }),
    null,
    "forcing a match would hide exactly the schema change this check exists to catch",
  );
});

test("a record with no total is still usable — the components are the measurement", () => {
  const b = bucketsFor({ input: 200, output: 20, cached: 50, thoughts: 5, tool: 0 });
  assert.equal(b.input, 150);
  assert.equal(b.cacheRead, 50);
  assert.equal(b.output, 25);
});

test("cached larger than input is not a shape we claim to understand", () => {
  assert.equal(bucketsFor({ input: 100, output: 10, cached: 500 }), null);
});

test("tool tokens are counted as generated output", () => {
  const b = bucketsFor({ input: 500, output: 40, cached: 100, thoughts: 10, tool: 25, total: 575 });
  assert.equal(b.output, 75, "output + thoughts + tool");
  assert.equal(b.input + b.output + b.cacheWrite + b.cacheRead, 575);
});

/* ---------------------------------------------------------------------------
   Reading real files.
   --------------------------------------------------------------------------- */

test("a revised turn supersedes the partial one it replaces", async () => {
  const events = await read();
  const m1 = events.filter((e) => e.ts.toISOString().startsWith("2026-03-01T09:00"));

  assert.equal(m1.length, 1, "one turn, not one per revision");
  assert.equal(total(m1[0]), 1350, "the later, fuller revision wins");
});

test("a session resumed in another file does not double-count", async () => {
  const events = await read();
  const m3 = events.filter((e) => e.ts.toISOString() === "2026-03-02T14:00:00.000Z");

  assert.equal(m3.length, 1, "the replayed turn is the same turn");
  assert.equal(total(m3[0]), 575);
});

test("repeated scans are idempotent", async () => {
  const a = await read();
  const b = await read();

  assert.equal(a.length, b.length);
  assert.equal(
    a.reduce((n, e) => n + total(e), 0),
    b.reduce((n, e) => n + total(e), 0),
  );
});

test("unusable records are dropped without discarding the valid ones around them", async () => {
  const events = await read();
  const stamps = events.map((e) => e.ts.toISOString());

  // m4 contradicts its total, m5 has cached > input, m6 has no timestamp, m8 is truncated.
  assert.ok(!stamps.includes("2026-03-02T15:00:00.000Z"), "contradictory total dropped");
  assert.ok(!stamps.includes("2026-03-02T16:00:00.000Z"), "cached > input dropped");
  assert.ok(!stamps.includes("2026-03-02T18:00:00.000Z"), "truncated line dropped");

  // ...and the good records in the same files survive.
  assert.ok(stamps.includes("2026-03-02T14:00:00.000Z"));
  assert.ok(stamps.includes("2026-03-02T17:00:00.000Z"));
});

test("envelope lines carrying message history contribute nothing", async () => {
  const events = await read();
  // The fixture's `$set` line holds a user message and no tokens.
  assert.ok(events.every((e) => total(e) > 0));
  assert.ok(events.every((e) => e.agent === "gemini"));
});

test("no prompt, reply or project identity reaches a UsageEvent", async () => {
  const events = await read();
  const serialised = JSON.stringify(events);

  for (const forbidden of ["SYNTHETIC_PROMPT", "SYNTHETIC_REPLY", "projectHash", "REDACTED", "content"]) {
    assert.ok(!serialised.includes(forbidden), `event leaked ${forbidden}`);
  }
  assert.deepEqual(
    Object.keys(events[0]).sort(),
    ["agent", "cacheRead", "cacheWrite", "input", "model", "output", "sourceId", "ts"],
    "the event carries usage, a model id, a clock and a session identity, and nothing else",
  );

  /*
   * `sourceId` is the one field that could quietly become an identifier, so it is pinned
   * rather than merely allowed.
   *
   * It must be the agent's own session id, read from the recording's header row — not the
   * file's name (a path), not `projectHash` (a directory identity, which the brief puts
   * outside the contract hashed or not), and not anything derived from either.
   */
  assert.equal(events[0].sourceId, "s1", "the session id comes from the row, verbatim");
  assert.ok(
    events.every((e) => e.sourceId === "s1" || e.sourceId === undefined),
    "a source is either the recording's declared session or absent — never invented",
  );

  /* The proj-b fixtures carry no header row, which is the real shape of a recording whose
     session line was never written. Those turns must come through *without* a source rather
     than with one derived from the filename: the ledger's answer to "no identity" is to bank
     the usage where it cannot be merged across machines, and that is strictly better than a
     path-shaped identity that would merge two different people's work. */
  assert.ok(
    events.some((e) => e.sourceId === undefined),
    "a recording with no session header yields events with no source",
  );
});

test("an absent tree is absent, not an error", async () => {
  const events = [];
  for await (const e of createGemini(join(HERE, "fixtures", "no-such-dir")).read()) events.push(e);
  assert.deepEqual(events, []);
  assert.equal(await createGemini(join(HERE, "fixtures", "no-such-dir")).detect(), "absent");
});

test("detection reports ready only when a countable turn exists", async () => {
  assert.equal(await createGemini(ROOT).detect(), "ready");
});
