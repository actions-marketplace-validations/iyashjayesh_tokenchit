import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregate, buildBadges, buildRecap, buildRecapSvg, RAMP, WEEKDAYS } from "../dist/index.js";

/** An event at a given local weekday-and-hour. 2026-05-18 is a Monday. */
const at = (mondayOffset, hour, tokens = 1000) => ({
  agent: "claude-code",
  ts: new Date(2026, 4, 18 + mondayOffset, hour, 0, 0),
  model: "claude-opus-5",
  input: tokens,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
});

const NOW = new Date(2026, 4, 25, 12, 0, 0);

test("the grid is Monday-first and bucketed by local hour", async () => {
  const stats = await aggregate([at(0, 9), at(6, 23)], { now: NOW });

  assert.equal(stats.heat[0][9], 1000, "Monday 09:00");
  assert.equal(stats.heat[6][23], 1000, "Sunday 23:00");
  assert.equal(stats.byWeekday[0], 1000);
  assert.equal(stats.byHour[9], 1000);
  assert.equal(WEEKDAYS[0], "MON");
});

test("cells are ranked across distinct values, not scaled against the busiest", async () => {
  // One violently dominant cell plus a spread of smaller ones. A linear scale against the
  // max would flatten every small cell to level 0 and make the grid unreadable.
  const events = [at(0, 10, 10_000_000)];
  for (let h = 0; h < 8; h++) events.push(at(1, h, (h + 1) * 100));

  const recap = buildRecap(await aggregate(events, { now: NOW }), { year: 2026 });
  const used = new Set(recap.rows.flatMap((r) => r.levels).filter((l) => l > 0));

  assert.ok(used.size >= 3, `expected a spread of levels, saw ${[...used].join(",")}`);
  assert.equal(Math.max(...used), 4, "the dominant cell still tops the ramp");
});

test("an empty hour is always level zero", async () => {
  const recap = buildRecap(await aggregate([at(0, 10)], { now: NOW }), { year: 2026 });

  assert.equal(recap.rows[0].levels[10], 4, "the only active hour is the hottest");
  assert.equal(recap.rows[0].levels[11], 0);
  assert.equal(recap.rows[1].levels.every((l) => l === 0), true, "an empty day stays cold");
});

test("the peak window widens from the busiest hour while neighbours stay substantial", async () => {
  const events = [
    ...Array.from({ length: 5 }, () => at(0, 14, 1000)), // 5000 at 14:00
    ...Array.from({ length: 3 }, () => at(0, 15, 1000)), // 3000 at 15:00 — above a third
    at(0, 16, 100), // well below a third, so the window stops before it
    at(0, 3, 2000), // above the one-third floor but not contiguous, so it must stay out
  ];

  const recap = buildRecap(await aggregate(events, { now: NOW }), { year: 2026 });

  assert.deepEqual(recap.peak, { from: 14, to: 15 });
});

test("no activity means no peak rather than a bogus one", async () => {
  const recap = buildRecap(await aggregate([], { now: NOW }), { year: 2026 });

  assert.equal(recap.peak, null);
  assert.equal(recap.rows.length, 7);
  assert.equal(recap.rows.every((r) => r.levels.every((l) => l === 0)), true);
  assert.equal(recap.tiles.equivCost, "—", "no priced tokens means a dash, not $0");
});

test("exactly one day is marked busiest", async () => {
  const recap = buildRecap(
    await aggregate([at(0, 10, 5000), at(1, 10, 1000)], { now: NOW }),
    { year: 2026 },
  );

  assert.deepEqual(
    recap.rows.filter((r) => r.busiest).map((r) => r.day),
    ["MON"],
  );
  assert.equal(recap.rows[1].share, 20, "Tuesday is a fifth of Monday");
});

test("the recap SVG renders and stays inside its frame", async () => {
  const recap = buildRecap(await aggregate([at(0, 10), at(3, 16)], { now: NOW }), { year: 2026 });
  const svg = buildRecapSvg({ handle: "octocat", recap, theme: "light" });

  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.match(svg, /@octocat/);
  assert.match(svg, /2026/);

  // Nothing may be drawn past the 495x330 frame.
  for (const [, x] of svg.matchAll(/\sx="([\d.]+)"/g)) assert.ok(Number(x) <= 495, `x=${x}`);
  for (const [, y] of svg.matchAll(/\sy="([\d.]+)"/g)) assert.ok(Number(y) <= 330, `y=${y}`);
});

test("dark recaps swap the coldest ramp step so empty cells are not near-white", async () => {
  const recap = buildRecap(await aggregate([at(0, 10)], { now: NOW }), { year: 2026 });

  const light = buildRecapSvg({ handle: "octocat", recap, theme: "light" });
  const dark = buildRecapSvg({ handle: "octocat", recap, theme: "dark" });

  assert.ok(light.includes(RAMP[0]), "light keeps the design's coldest step");
  assert.ok(!dark.includes(RAMP[0]), "dark must not paint near-white cells");
  assert.ok(dark.includes("#1C1C18"));
});

test("the streak tile is the year's longest run, not the current one", async () => {
  /*
   * The tile has always been named `longestStreak` and rendered as STREAK on the card, and it
   * was assigned `stats.streakDays` — which aggregate documents as "consecutive local days
   * with activity, ending today or yesterday", the *current* run. In a year in review the two
   * are barely related: a recap read in January reports a day or two while the year's best may
   * have been thirty in June. The name was right and the value was wrong.
   */
  const day = (month, date, hour = 10) => ({
    agent: "claude-code",
    ts: new Date(2026, month - 1, date, hour, 0, 0),
    model: "claude-opus-5",
    input: 1000,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  });

  const events = [];
  for (let d = 1; d <= 5; d++) events.push(day(3, d)); //  5 days in March
  for (let d = 10; d <= 21; d++) events.push(day(6, d)); // 12 days in June — the longest
  for (let d = 24; d <= 25; d++) events.push(day(5, d)); //  2 days ending "now"

  const now = new Date(2026, 4, 25, 18, 0, 0);
  const stats = await aggregate(events, { now });

  assert.equal(stats.streakDays, 2, "the current run is the two days ending today");
  assert.equal(
    buildRecap(stats, { year: 2026, now }).tiles.longestStreak,
    "12d",
    "but the tile reports June's run, which is what a year in review is about",
  );

  // A run belonging to another year is not this year's achievement.
  assert.equal(buildRecap(stats, { year: 2025, now }).tiles.longestStreak, "0d");
});

/* ---------------------------------------------------------------------------
   Monthly rollup, biggest day, peak provenance, and activity badges.
   --------------------------------------------------------------------------- */

/** An event on a specific local date. */
const day = (y, m, d, over = {}) => ({
  agent: "claude-code",
  ts: new Date(y, m - 1, d, 14, 0, 0),
  model: "claude-opus-5",
  input: 1000,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  ...over,
});

test("months covers the whole year, including the empty ones", async () => {
  const stats = await aggregate([day(2026, 3, 4), day(2026, 3, 5)], { now: NOW });
  const recap = buildRecap(stats, { year: 2026 });

  assert.equal(recap.months.length, 12, "a gap is information; absent months would hide it");
  assert.deepEqual(recap.months.map((m) => m.label).slice(0, 3), ["JAN", "FEB", "MAR"]);
  assert.equal(recap.months[2].tokens, 2000);
  assert.equal(recap.months[0].tokens, 0);
  assert.equal(recap.months[2].share, 100, "the busiest month sets the scale");
  assert.equal(recap.months[0].share, 0);
});

test("months is scoped to the year the recap names", async () => {
  // aggregate() filters by year, so a prior-year event must not appear in this year's rollup.
  const stats = await aggregate([day(2026, 1, 9), day(2025, 12, 9)], { year: 2026, now: NOW });
  const recap = buildRecap(stats, { year: 2026 });

  assert.equal(recap.months.reduce((a, m) => a + m.tokens, 0), 1000);
});

test("biggestDay carries both the raw number and a display string", async () => {
  const stats = await aggregate(
    [day(2026, 2, 1), day(2026, 2, 2, { input: 50_000 })],
    { now: NOW },
  );
  const recap = buildRecap(stats, { year: 2026 });

  assert.equal(recap.biggestDay.day, "2026-02-02");
  assert.equal(recap.biggestDay.tokens, 50_000);
  assert.equal(typeof recap.biggestDay.display, "string");
});

test("an empty year reports no biggest day and no badges", async () => {
  const recap = buildRecap(await aggregate([], { now: NOW }), { year: 2026 });

  assert.equal(recap.biggestDay, null);
  assert.deepEqual(recap.badges, []);
  assert.equal(recap.peak, null);
  assert.equal(recap.peakCoverage, 0);
  assert.equal(recap.months.length, 12);
});

test("peak ignores replayed days and reports its own coverage", async () => {
  /* The correction this stage exists for. A history mostly recovered from the ledger used to
     produce a confident midday peak that was an artefact of replay, not an observation. */
  const stats = await aggregate(
    [
      at(0, 23, 40_000),
      { ...day(2026, 5, 19), input: 60_000, tsPrecision: "day", ts: new Date(2026, 4, 19, 12, 0, 0) },
    ],
    { now: NOW },
  );
  const recap = buildRecap(stats, { year: 2026 });

  assert.ok(recap.peak, "the observed evening event still supports a peak");
  assert.equal(recap.peak.from, 23);
  assert.equal(recap.peak.to, 23, "noon must not widen the window");
  assert.equal(Math.round(recap.peakCoverage * 100), 40, "40% of tokens were observed");
});

test("peak is null when every day was replayed", async () => {
  const stats = await aggregate(
    [{ ...day(2026, 5, 19), tsPrecision: "day" }, { ...day(2026, 5, 20), tsPrecision: "day" }],
    { now: NOW },
  );
  const recap = buildRecap(stats, { year: 2026 });

  assert.equal(recap.peak, null, "no observed clock means no claim about time of day");
  assert.equal(recap.peakCoverage, 0);
});

test("Night Owl needs observed late tokens, and does not fire on replayed ones", async () => {
  const late = Array.from({ length: 20 }, (_, i) => at(i % 7, 23, 10_000));
  const withClock = buildRecap(await aggregate(late, { now: NOW }), { year: 2026 });
  assert.ok(withClock.badges.some((b) => b.id === "night-owl"));

  const replayed = late.map((e) => ({ ...e, tsPrecision: "day" }));
  const withoutClock = buildRecap(await aggregate(replayed, { now: NOW }), { year: 2026 });
  assert.ok(
    !withoutClock.badges.some((b) => b.id === "night-owl"),
    "a synthesised noon must never earn a time-of-day badge",
  );
});

test("no badge is awarded below its minimum data", async () => {
  // One small late-night event: the right shape, nowhere near enough of it.
  const recap = buildRecap(await aggregate([at(0, 23, 100)], { now: NOW }), { year: 2026 });
  assert.deepEqual(recap.badges, []);
});

test("Agent Explorer counts agents with real weight, not a single stray event", async () => {
  const many = Array.from({ length: 30 }, (_, i) => at(i % 7, 10, 10_000));
  const stray = { ...at(0, 10, 5), agent: "codex", tsPrecision: "session" };

  const withStray = buildRecap(await aggregate([...many, stray], { now: NOW }), { year: 2026 });
  assert.ok(
    !withStray.badges.some((b) => b.id === "agent-explorer"),
    "one event from a second agent is not exploration",
  );

  const real = Array.from({ length: 30 }, (_, i) => ({
    ...at(i % 7, 10, 10_000),
    agent: "codex",
    tsPrecision: "session",
  }));
  const withBoth = buildRecap(await aggregate([...many, ...real], { now: NOW }), { year: 2026 });
  assert.ok(withBoth.badges.some((b) => b.id === "agent-explorer"));
});

test("no badge rewards spending or raw volume", async () => {
  // A deliberately enormous single day. Nothing here should congratulate it.
  const huge = buildRecap(
    await aggregate([day(2026, 6, 1, { input: 50_000_000_000 })], { now: NOW }),
    { year: 2026 },
  );

  for (const b of huge.badges) {
    assert.ok(
      !/token|spend|cost|goblin|hoard/i.test(`${b.id} ${b.label}`),
      `badge ${b.id} must not celebrate volume`,
    );
  }
});

/* ---------------------------------------------------------------- *
 * Locked In, Model Gambler, and year-over-year
 * ---------------------------------------------------------------- */

const stamp = (y, mo, d, h, mi, over = {}) => ({
  agent: "claude-code",
  ts: new Date(y, mo, d, h, mi, 0),
  model: "claude-opus-5",
  input: 1000,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  sourceId: "s1",
  ...over,
});

const streamOf = async function* (events) {
  for (const e of events) yield e;
};

test("a resumed session is not one enormous sitting", async () => {
  /*
   * The trap this guards, found by measuring before implementing. Claude Code sessions are
   * resumed days or weeks later, so first-to-last within a session reaches 792 hours on a real
   * corpus. Reporting that as "longest session" would have been a plausible, confident lie:
   * two hours of work either side of a fortnight's gap.
   */
  const events = [
    // Forty minutes of continuous work, in steps under the 30-minute idle threshold...
    stamp(2026, 4, 1, 9, 0),
    stamp(2026, 4, 1, 9, 20),
    stamp(2026, 4, 1, 9, 40),
    // ...then the same session resumed a fortnight later, for twenty more.
    stamp(2026, 4, 15, 9, 0),
    stamp(2026, 4, 15, 9, 20),
  ];

  const stats = await aggregate(streamOf(events));
  assert.ok(stats.focus, "nothing was measured");
  assert.equal(stats.focus.longestStretchMin, 40, "the fortnight-long gap was counted as work");
  assert.equal(stats.focus.stretches, 2, "a resumed session is two stretches, not one");
});

test("a stretch ends at a long idle gap, not at a short one", async () => {
  const stats = await aggregate(
    streamOf([
      stamp(2026, 4, 1, 9, 0),
      stamp(2026, 4, 1, 9, 20), // 20 min gap: same sitting
      stamp(2026, 4, 1, 9, 40),
      stamp(2026, 4, 1, 12, 0), // 140 min gap: a new one
      stamp(2026, 4, 1, 12, 10),
    ]),
  );
  assert.equal(stats.focus.longestStretchMin, 40);
  assert.equal(stats.focus.stretches, 2);
});

test("Locked In needs observed clocks, and enough of them", async () => {
  /* Four hours of continuous work: an event every twenty minutes, so no gap reaches the
     thirty-minute threshold that would split it. */
  const continuous = [];
  for (let m = 0; m <= 240; m += 20) continuous.push(stamp(2026, 4, 1, 9, m));

  // A single long stretch is not evidence of a habit, so the badge needs a corpus behind it.
  const one = await aggregate(streamOf(continuous));
  assert.equal(one.focus.longestStretchMin, 240, "four hours of unbroken work");
  assert.ok(one.focus.stretches < 20, "and only a handful of stretches behind it");
  assert.equal(
    buildBadges(one).some((b) => b.id === "locked-in"),
    false,
    "one stretch should not earn it",
  );

  /* A ledger replay carries a real date and an invented noon. Letting that define a sitting
     would manufacture one that never happened. */
  const replayed = await aggregate(
    streamOf([
      stamp(2026, 4, 1, 12, 0, { tsPrecision: "day", sourceId: undefined }),
      stamp(2026, 4, 2, 12, 0, { tsPrecision: "day", sourceId: undefined }),
    ]),
  );
  assert.equal(replayed.focus, null, "synthesised clocks must not produce a stretch");
});

test("Model Gambler needs three models carrying real weight", async () => {
  const mix = (models) =>
    streamOf(models.map((m, i) => stamp(2026, 4, (i % 20) + 1, 10, 0, { model: m.model, input: m.tokens })));

  // Two heavy models and a tail: a provider rotating a snapshot date is not a gamble.
  const two = await aggregate(
    mix([
      { model: "opus", tokens: 5000 },
      { model: "sonnet", tokens: 4000 },
      { model: "haiku", tokens: 100 },
    ]),
  );
  assert.equal(buildBadges(two).some((b) => b.id === "model-gambler"), false);

  const three = await aggregate(
    mix([
      { model: "opus", tokens: 4000 },
      { model: "sonnet", tokens: 3000 },
      { model: "haiku", tokens: 3000 },
    ]),
  );
  assert.equal(buildBadges(three).some((b) => b.id === "model-gambler"), true);
});

test("byYear survives the year filter, because the comparison depends on it", async () => {
  const stats = await aggregate(
    streamOf([stamp(2025, 4, 1, 10, 0, { input: 500 }), stamp(2026, 4, 1, 10, 0, { input: 1500 })]),
    { year: 2026 },
  );
  assert.equal(stats.tokens, 1500, "the scoped total describes the year asked for");
  assert.equal(stats.byYear.get(2025), 500, "and the year before it is still available");
  assert.equal(stats.byYear.get(2026), 1500);
});

test("a year that predates recorded history is not a collapse in usage", async () => {
  const stats = await aggregate(
    streamOf([stamp(2025, 4, 1, 10, 0, { input: 500 }), stamp(2026, 4, 1, 10, 0, { input: 1500 })]),
  );

  const honest = buildRecap(stats, { year: 2026, historyFrom: "2024-01-01" });
  assert.equal(honest.previousYear.reason, "comparable");
  assert.equal(honest.previousYear.deltaPct, 200, "500 to 1500 is +200%");

  // Installed part-way through the baseline year: the percentage measures the install date.
  const partial = buildRecap(stats, { year: 2026, historyFrom: "2025-06-01" });
  assert.equal(partial.previousYear.reason, "partial-baseline");
  assert.equal(partial.previousYear.deltaPct, null, "a percentage was shown anyway");

  // Installed after the baseline year ended entirely.
  const none = buildRecap(stats, { year: 2026, historyFrom: "2026-01-01" });
  assert.notEqual(none.previousYear.reason, "comparable");
  assert.equal(none.previousYear.deltaPct, null);
});

/* ---------------------------------------------------------------- *
 * Badges on the card
 * ---------------------------------------------------------------- */

/** A recap with an arbitrary badge set, so the layout can be tested independently of the rules. */
const recapWithBadges = (labels) => ({
  year: 2026,
  tiles: { totalTokens: "15.5B", equivCost: "$10,058", topModel: "opus", longestStreak: "35d" },
  rows: WEEKDAYS.map((day) => ({
    day,
    tokens: 100,
    busiest: 0.5,
    levels: Array(24).fill(2),
    colours: Array(24).fill(RAMP[2]),
  })),
  peak: { from: 10, to: 20 },
  peakCoverage: 0.89,
  months: [],
  biggestDay: null,
  agents: [],
  models: [],
  activeDays: 59,
  tokens: 1,
  previousYear: null,
  badges: labels.map((label) => ({ id: label, label, detail: "" })),
});

const heightOf = (svg) => Number(/height="(\d+)" viewBox/.exec(svg)[1]);
const pillsIn = (svg) =>
  [...svg.matchAll(/<rect (?:class="bg" )?x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="14" rx="7"/g)]
    .map(([, x, y, w]) => ({ x: Number(x), y: Number(y), w: Number(w) }));

const ALL_BADGES = [
  "Night Owl",
  "Weekend Zombie",
  "Agent Explorer",
  "Model Gambler",
  "Locked In",
  "No Days Off",
  "Steady Hand",
];

test("a card with no badges is exactly the card that shipped before them", () => {
  /* Nothing moves for somebody who earned none. The height is the whole test: if badges
     reserved space unconditionally, every existing card would have grown a blank strip. */
  const svg = buildRecapSvg({ handle: "octocat", recap: recapWithBadges([]), theme: "light" });
  assert.equal(heightOf(svg), 330);
  assert.equal(pillsIn(svg).length, 0);
});

test("badges render as pills, and the card grows by exactly the rows they need", () => {
  const one = buildRecapSvg({ handle: "octocat", recap: recapWithBadges(ALL_BADGES.slice(0, 3)), theme: "light" });
  assert.equal(pillsIn(one).length, 3);
  assert.equal(heightOf(one), 352, "one row of badges");
  for (const label of ALL_BADGES.slice(0, 3)) assert.ok(one.includes(label), `${label} is missing`);

  const all = buildRecapSvg({ handle: "octocat", recap: recapWithBadges(ALL_BADGES), theme: "light" });
  assert.equal(pillsIn(all).length, 7, "every badge earned is shown, none dropped");
  assert.equal(heightOf(all), 374, "two rows");
});

test("no pill overflows the card or collides with the footer", () => {
  /*
   * Wrapped rather than truncated or scaled: text spilling out of its pill reads as a rendering
   * bug, and dropping a badge to save 20px is the wrong trade on the one artifact whose job is
   * to show what somebody earned.
   */
  for (const n of [1, 3, 5, 7]) {
    const svg = buildRecapSvg({ handle: "octocat", recap: recapWithBadges(ALL_BADGES.slice(0, n)), theme: "light" });
    const pills = pillsIn(svg);
    const height = heightOf(svg);

    for (const p of pills) {
      assert.ok(p.x >= 28, `${n} badges: a pill starts left of the margin`);
      assert.ok(p.x + p.w <= 495 - 28, `${n} badges: a pill runs past the right margin`);
    }
    const lowest = Math.max(...pills.map((p) => p.y + 14));
    assert.ok(lowest <= height - 14 - 4, `${n} badges: a pill collides with the footer`);

    // Rows must not overlap each other either.
    const ys = [...new Set(pills.map((p) => p.y))].sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i += 1) {
      assert.ok(ys[i] - ys[i - 1] >= 14, `${n} badges: badge rows overlap`);
    }
  }
});

test("the pill outline survives a dark card", () => {
  /* `.lg` only carries fills, so an outline drawn with it would keep the light stroke on a dark
     ground and read as a grey box. */
  const auto = buildRecapSvg({ handle: "octocat", recap: recapWithBadges(ALL_BADGES), theme: "auto" });
  assert.match(auto, /\.bg\{stroke:/, "no dark rule for the pill outline");
  assert.equal((auto.match(/class="bg"/g) ?? []).length, 7, "pills are not targetable by that rule");

  const dark = buildRecapSvg({ handle: "octocat", recap: recapWithBadges(ALL_BADGES), theme: "dark" });
  assert.ok(!dark.includes('stroke="#55554E"'), "a dark card kept the light stroke");
});

test("a label too wide for the card is shortened rather than allowed to run off it", () => {
  /*
   * Not reachable by any badge this tool awards — the longest is "Weekend Zombie" at fourteen
   * characters — so this is a guard for whoever adds the next one. Wrapping cannot rescue a
   * single label wider than the card, and text running past the artwork's edge reads as a
   * broken renderer rather than a long name.
   */
  const svg = buildRecapSvg({
    handle: "octocat",
    recap: recapWithBadges(["A".repeat(200)]),
    theme: "light",
  });

  const [pill] = pillsIn(svg);
  assert.ok(pill, "no pill was drawn at all");
  assert.ok(pill.x + pill.w <= 495 - 28, "the pill ran past the right margin");
  assert.match(svg, /…<\/text>/, "the label was not visibly shortened");
});

test("badge labels are escaped into the card", () => {
  /* Labels are our own strings today, so this is defence in depth rather than a live hole —
     but the card is a file people commit and a site renders. */
  const svg = buildRecapSvg({
    handle: "octocat",
    recap: recapWithBadges(['</text><script>alert(1)</script>', 'Tom & Jerry']),
    theme: "light",
  });

  assert.ok(!svg.includes("<script>"), "a script tag reached the output");
  assert.ok(svg.includes("&lt;/text&gt;"), "the payload was not escaped");
  assert.ok(svg.includes("Tom &amp; Jerry"), "an ampersand was not escaped");
  assert.equal(
    (svg.match(/<text/g) ?? []).length,
    (svg.match(/<\/text>/g) ?? []).length,
    "text elements are unbalanced",
  );
});
