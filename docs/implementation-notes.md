# Implementation notes — recap enrichment and beyond

A resumable record of the staged work described in the September 2026 implementation brief.
Each stage is a reviewable unit: it is either done and verified, or it is not started.

**Repository state at start:** `d17b93a`, working tree clean.
**Code-review graph:** empty (0 nodes, 0 edges, 0 files) at session start, so this work used
targeted reads and searches rather than graph queries.

---

## Status

| Stage | State |
| --- | --- |
| 1 — Enrich the existing recap | **Done and verified** |
| 2 — Validated Gemini CLI support | **Done and verified** |
| 3 — Read-only data-health diagnostics (`doctor`) | **Done and verified** |
| 4 — Local sharing pack (PNG export) | **Done and verified** |
| 5 — Portable history and multi-device merge | Not started |

---

## Stage 1 — what shipped

### The problem underneath it

Three different kinds of observation were flowing through one `UsageEvent.ts` field and being
counted as the same evidence:

- **Claude Code, OpenCode** stamp each exchange. Exact.
- **Codex** reports a running counter, so one rollout contributes a single event dated at its
  *last turn*. The day is right; the hour is only the hour it finished.
- **Ledger replay** stores a day and synthesises **local noon** to put it back.

`byHour`, `byWeekday` and `heat` counted all three. That was a knowing trade for the heatmap —
`ledger.ts` says so: "a wrong hour is a much smaller lie than a missing fortnight". It is not an
acceptable trade for a *new* claim about when somebody works, and the brief forbids it.

### The design

`UsageEvent` gained an optional `tsPrecision: "exact" | "session" | "day"`. Absent means
`exact`, so every existing producer and consumer is unchanged. `Stats` gained parallel
**observed-clock** series:

- `clockByHour`, `clockByWeekday`, `clockTokens` — built only from events with a real clock
- `byHour`, `byWeekday`, `heat` — **unchanged**, still counting everything

Keeping both was deliberate. Dropping replays from the heatmap would empty it for anyone whose
logs have rotated, and an emptier map is its own lie. So the heatmap keeps its existing trade,
and the peak headline and time-of-day badges read the observed series instead.

The persisted ledger format is untouched: the tag lives on in-memory events only, and buckets
remain four-number tuples.

### Significant tradeoffs

**`Recap.peak` changed meaning.** It now reads `clockByHour` rather than `byHour`. This is a
behaviour change to an existing field, made deliberately because the brief requires it: a
mostly-recovered history previously produced a confident "peak 12:00–13:00" that was an
artefact of this tool's own replay. `peakCoverage` (0–1) reports how much of the total the
window actually saw, and the CLI prints it whenever it is below 100%. When *no* day has an
observed clock, `peak` is `null` and the CLI explains why rather than inventing a window.

**`--week` / `--month` write no SVG.** The recap card is a year card: a weekday-by-hour grid
with annual tiles. Seven days rendered into it reads as a quiet year, not a short window. Both
flags print to the terminal and to `--json`. A card designed for a short period is separate work.

**`--week` / `--month` scan unscoped by year.** A completed week in early January reaches back
into December; a year filter would truncate the baseline to zero and report it as a collapse.

**Comparability is a first-class result, not a missing number.** `deltaPct` is `null` — never
zero, never infinity — whenever the previous period cannot support a rate, and
`comparability.detail` says why in the user's terms. Four distinct cases:

| Case | `reason` |
| --- | --- |
| No history at all | `no-baseline` |
| History starts *inside* the prior period | `partial-baseline` |
| Prior period predates history but the logs still show figures | `partial-baseline` |
| Prior period fully covered and genuinely empty | `no-baseline` |

That third case matters in practice. On this machine `recap --month` shows **+8.50B** against
July — which as a percentage would have read as roughly +3500% growth. The real cause is that
July predates the ledger's `since`. The absolute change is still reported; the rate is not.

### Badges

Five, all deterministic, all from existing `Stats`, none using an LLM or inferring sessions:

| Badge | Threshold | Minimum data |
| --- | --- | --- |
| Night Owl | ≥25% of **observed** tokens in 22:00–05:00 | 100k observed tokens |
| Weekend Zombie | ≥35% of observed tokens Sat/Sun (a flat week is ≈28.6%) | 100k observed + 14 active days |
| Agent Explorer | ≥2 agents each above 10% of tokens | — |
| No Days Off | current streak ≥14 days | — |
| Steady Hand | busiest day ≤2.5× an even spread | 14 active days |

Deliberately absent: spending milestones, volume trophies, population percentiles, session
inference. This project's own position is that the card measures usage rather than output and
cannot tell work from a retry loop, so a badge celebrating a bigger number would argue against
the product. **Steady Hand is the counterweight** — the one badge a heavier user is *less*
likely to earn, because it describes even distribution rather than volume.

Time-of-day badges read the observed series only, so a replayed day can never earn one. A test
asserts exactly that.

### Ties and determinism

`biggestDay` keeps the **earlier** day on a tie, so identical input always produces an
identical headline. Tested by feeding the same events in both orders.

### Verification

- `npm test` — 108 core / 33 CLI / 23 MCP / 4 site, all passing.
- 27 tests added across `aggregate`, `recap` and a new `period` suite, covering: month rollup
  and year scoping; biggest day and tie stability; replayed days excluded from observed clocks;
  peak null when nothing was observed; badges suppressed below minimum data; no badge naming
  volume; week and month boundaries on Mondays, Sundays and month ends; **leap years**
  (2028-02-29 vs 2026-02-28); **DST weeks** (late March and late October still span 7 days);
  and all four comparability cases.
- Run against real local logs: `recap`, `recap --week`, `recap --month`, `--json`, and the
  conflicting-flag rejection. Annual SVG still renders (17,933 bytes).

### Known limitations

- Per-period **cost** is not reported. The day series carries tokens, not cost, so a per-period
  equivalent-cost split would need day-level cost accounting. Rather than approximate it,
  `PeriodReport` omits cost entirely.
- `historyFrom` defaults to the ledger's `since`. If a user deletes the ledger, comparisons
  become conservative again until it rebuilds — correct, but it will surprise someone.
- The site's recap component has not been updated to show months, biggest day or badges. The
  data flows through `buildRecap`, so it is available; only the presentation is outstanding.
- MCP `get_recap` returns the enriched object automatically (it serialises `buildRecap`'s
  result), but its tool description does not yet mention the new fields.
- README and `recap` long-form docs describe the new flags via `tokenchit help recap`; the
  README itself has not been updated.


---

## Stage 3 — `tokenchit doctor`

### What it does

One command answering "why does this number look wrong". The explanations already existed but
were spread across three commands — `sync` warns about recovered days and price coverage,
`init` lists detected and unsupported agents, `ledger` shows the bank — so nobody saw the whole
picture at once, which is exactly what a discrepancy report needs.

Reports: recognised agents with detection state and source glob, observed date bounds, retained
history and what it restored this run, price coverage with the unpriced models named, and the
accounting limitations that **actually apply to this machine** rather than a static list.

`--json` emits a versioned object (`version: 1`).

### Read-only is a contract, not an intention

`scan({ write: false })` never calls `writeLedger`, and the OpenCode adapter already opens its
SQLite database with `readOnly: true`, so no `-wal` or `-shm` sidecar appears. No existing
helper needed changing — the read-only path was already there.

Tests assert this rather than assuming it, by **content fingerprint** over the fixture home and
the config directory before and after. The fingerprint deliberately hashes contents and names
only, never mtime or atime: reading a file updates its access time on many systems, and a test
treating that as a write would fail a command behaving perfectly. Separate tests assert no
sidecar/temp/lock file appears anywhere, and that a machine with no ledger still has none
afterwards.

### Deliberate omissions

- **No completeness percentage.** Observed bounds do not prove the days between them are
  complete: a silent day and a day whose transcripts were deleted are indistinguishable from
  here. A test asserts the `observed` object carries no key matching `complete|coverage|percent`.
- **No remediation.** Suggestions are printed for the user to run. Nothing is applied, no
  config is repaired, no hook installed, no credential refreshed.
- **Exit code 0 for an empty machine.** A fresh install with no usage is a correct state to be
  in, not a failure.

### Limitations

- Source *globs* appear in the output by design — that is documentation of where an adapter
  looks, not a path harvested from the user. A test asserts no transcript content or project
  path leaks.
- `doctor` runs a full scan, so on a large corpus it takes as long as `sync` does. It has no
  cheaper detection-only mode.


---

## Stage 2 — Gemini CLI: verified findings, adapter not yet written

The research was treated as dated evidence and re-checked against real recordings on this
machine before any parser was designed. Two things it said needed correcting, and the
accounting question it flagged now has a measured answer.

### What is actually on disk

`~/.gemini/tmp/<project>/chats/session-*.jsonl`, **2,141 files** on this machine.

Two distinct record shapes are present:

1. **The common shape (2,139 files).** JSONL lines carrying `sessionId`, `projectHash`,
   `startTime`, `lastUpdated`, `kind` and a `$set` envelope whose `messages[]` have only
   `id`, `timestamp`, `type`, `content`. **No token fields at any depth.**
2. **The token-bearing shape (2 files, 46 records).** JSONL lines with a top-level `tokens`
   object alongside `id`, `timestamp`, `type`, `model`, `content`, `thoughts`.

So the current `unsupported.ts` reason is **not simply stale** — it is accurate for the
overwhelming majority of what this installation has written. The right description is a
*partial* state: newer recordings are countable, older ones are not, and an installed client
with uncountable sessions is a partial/unavailable state rather than a fabricated zero.

### The accounting answer — measured, not assumed

The token object is always exactly:

```
{ input, output, cached, thoughts, tool, total }
```

Four hypotheses were tested against all 46 records:

| Hypothesis for `total` | Matches |
| --- | --- |
| `input + output + cached + thoughts + tool` (all disjoint) | **9 / 46** |
| `input + output + thoughts + tool` (cached **inside** input) | **46 / 46** |
| `input + output + tool` (cached and thoughts inside) | 0 / 46 |
| `input + output` (everything else inside) | 0 / 46 |

**`cached` is nested inside `input`** — the same shape Codex uses for `cached_input_tokens`.
The first hypothesis appears to work only on the 9 records where `cached == 0`, which is
exactly the trap the brief warns about: sampling one zero-cache record would have "confirmed"
the wrong model.

Worked example: `{input: 8684, output: 52, cached: 7061, thoughts: 40, tool: 0, total: 8776}`.
Summing all five fields gives 15,837 against a reported total of 8,776 — an **80% inflation**
on a cache-heavy turn.

### The mapping this implies

To keep tokenchit's four buckets disjoint and reconcile exactly with Gemini's own total:

| tokenchit bucket | from Gemini |
| --- | --- |
| `input` | `input - cached` |
| `cacheRead` | `cached` |
| `output` | `output + thoughts + tool` |
| `cacheWrite` | `0` (Gemini reports none) |

This sums to `input + output + thoughts + tool`, which equals `total` on all 46 records. The
reported `total` should be used as **reconciliation evidence** — parse the components, then
assert they agree with `total`, and represent a disagreement explicitly rather than forcing it.

`thoughts` (reasoning) and `tool` are folded into `output` because both are generated tokens.
That is a judgement, not a measurement: it is the placement that preserves the disjoint-bucket
invariant and matches how these are billed, but a future pricing table distinguishing reasoning
rates would want them separated.

### Privacy note for the implementation

These files carry `projectHash` and a `content` field with full prompt and reply text. Neither
may be collected: the brief puts hashed and truncated paths outside the contract, and `content`
is raw transcript. Only `timestamp`, `model` and the `tokens` object may be read. Fixtures must
be synthetic, never copied from `~/.gemini`.

### What shipped

`packages/core/src/adapters/gemini.ts`, registered as a fourth real adapter. `AgentId` widened;
`unsupported.ts` no longer lists Gemini. The blast radius was smaller than feared — `validate.ts`
treats agents as bounded free-form strings rather than an enum, and the site stores `agent text`,
so only the TS union, the icon/colour table and the board filter needed touching.

**Reconciliation against real data.** Run against this machine's `~/.gemini`: 46 records,
**1,606,888 tokens**, matching the sum of Gemini's own reported `total` fields **exactly**. The
naive five-field reading gives 2,847,359 — **1.77× the truth**. Two consecutive scans are
identical.

**Detection is three-state on purpose.** `ready` only once a *countable* turn has been found;
`installed-no-data` when `~/.gemini` exists but nothing readable does — which is the real state
for an installation whose recordings all predate token recording. A user with years of older
sessions is told that rather than shown a confident zero.

**A bug found while wiring it.** `detect()` consulted the real `~/.gemini` even when a caller
passed an explicit root, so a non-existent test path reported `installed-no-data` purely because
this machine has Gemini installed. An explicitly-named root is now self-contained.

**A second bug found.** `packages/mcp/src/tools.ts` carried a *hardcoded copy* of the unsupported
list and had already drifted — it still called Gemini uncountable after Gemini became a real
adapter. It now sources the probes, so the one tool whose job is explaining what cannot be
counted cannot drift again.

**Agent colour was computed, not chosen.** The obvious Google blues both failed the table's
luminance-separation rule: `#4285F4` lands 0.007 from the neutral and `#1A73E8` 0.020 from
opencode, either of which would merge with a neighbour in greyscale. `#174EA6` (light, 0.084)
sits in the gap between codex and opencode; `#8AB4F8` (dark, 0.448) is 0.162 clear.

### Limitations

- Gemini models are **unpriced** — `prices.json` has no entry, so they contribute tokens and no
  cost. That is the designed behaviour for an unknown model, not a gap to paper over.
- `thoughts` and `tool` are folded into `output`. A pricing table distinguishing reasoning rates
  would want them separate.
- A turn with no `id` cannot be deduplicated and is kept under a synthetic key: losing real usage
  is worse than a small risk of double-counting a record the format does not let us identify.

## Stage 4 — local PNG export

### What the SVG is for, and what the PNG is not

The SVG stays the artifact this tool argues for: a committed file GitHub serves directly, sharp
at any size, a few kilobytes, and diffable. The PNG exists only for the places that will not
take one — a social feed, a slide, a chat window. It is therefore **written beside the SVG,
never instead of it**: `--png` adds an output rather than replacing the one that belongs in a
README, and the closing hints name the two separately so nobody embeds the raster copy by
mistake.

### Three things it deliberately is not

- **Not a screenshot.** No browser, no headless Chrome, no hosted renderer. `@resvg/resvg-js`
  rasterises the SVG this package already produces, in-process.
- **Not networked.** Nothing is fetched while rendering. The card names font *stacks* rather
  than one face — precisely because GitHub strips webfont references from README SVGs — so
  there is nothing to load, and no image is referenced by URL. `loadSystemFonts` resolves the
  same stack a browser on the same machine would.
- **Not an editor.** Three presets and the existing `hide`/`layout`/`theme` concepts. Anyone
  wanting pixel control has the SVG.

### The rasteriser is optional, and that is load-bearing

`@resvg/resvg-js` is a native module with per-platform prebuilt binaries. As a hard dependency
it would make `npm i -g tokenchit` fail on any machine with no prebuild and no toolchain — for
a feature most users never touch. It is an `optionalDependency`, imported lazily *inside*
`toPng`, so `sync`, `publish`, `recap`, `doctor` and the MCP server never load it. A machine
that cannot build it has a fully working CLI that simply cannot write a PNG, and is told so in
a sentence naming the fix rather than by a native-module stack trace.

This required `--external:@resvg/resvg-js` in the CLI's esbuild step: bundling a native module
fails outright, and the bundle must be able to *try* the import and fail softly at runtime.

### Presets frame rather than re-render

| Preset | Shape | Why |
| --- | --- | --- |
| `card` | the card's own 495×195, scaled | the default; nothing added |
| `square` | 1:1 | feeds that crop to a square would otherwise eat the card's own edges |
| `portrait` | 4:5 | the tallest most feeds show uncropped |

A preset nests the card's SVG **untouched** inside a padded canvas (SVG 1.1 `<svg>` nesting,
which resvg supports) rather than re-rendering it at a new size. A preset therefore cannot
change what the card says or how it is laid out — it only decides how much space surrounds it.
The framing axis only ever grows, never shrinks, so no preset can crop the card.

`--scale` is clamped to 1–6: below 1 the text stops being legible, above 6 the file is large for
no gain. A non-finite value falls back to 2 rather than throwing, because `--scale` is a quality
knob and a broken one should not fail a card that would otherwise have been written.

### `recap --png` and the period views

`recap --png` writes the year card the same way. `--week`/`--month` **reject** `--png` with a
message rather than ignoring it: those views write no SVG at all, so there is nothing to
rasterise, and silently producing no file for a flag the user typed reads as a broken export.

### Verified

Real PNGs generated and inspected at all three presets (card 990×390, square 1182×1182,
portrait 591×739 for the usage card; 1182×1478 for the taller recap card). Scale clamping
checked at the edges — `99` → 6×, `0.01` → 1×, `NaN` → 2×. A bad `--preset` is rejected by name.
The PNG test skips itself, rather than failing, where the optional rasteriser is absent.

### Limitations

- No hosted image endpoint and no Open Graph card. Both are network features; this stage is
  local-only by design.
- Fonts resolve against the rendering machine, so a PNG made on a machine with different fonts
  installed will differ slightly. The SVG has the same property in browsers and this is the
  behaviour that keeps rendering offline.
