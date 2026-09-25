import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_PAGES, UNSUPPORTED } from "../lib/agents.ts";
import { BOARD_AGENTS } from "../lib/board.ts";
import { adapters, unsupported } from "../../../packages/core/dist/adapters/index.js";

/**
 * The agent list is stated in prose in several places, and nothing tied those to the code.
 *
 * Gemini CLI became a real adapter and the registry, the icon table and the board filter were
 * all updated — while the site hero, the shared page description, the OG image, the profile
 * invite text, `init --help`, both READMEs and this site's own agents page went on saying
 * otherwise. Two of those did not merely omit it: they stated that Gemini *cannot be counted*,
 * which is the opposite of the truth and among the first things a reader sees.
 *
 * Prose cannot be generated from the registry — each agent's page is a real piece of writing.
 * But it can be *checked* against it, and that is the difference between a list that drifts and
 * one that cannot.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const supportedIds = adapters.map((a) => a.id).sort();
const unsupportedNames = unsupported.map((p) => p.name).sort();

test("the site has a page for every supported adapter, and no others", () => {
  assert.deepEqual(
    AGENT_PAGES.map((p) => p.key).sort(),
    supportedIds,
    "an adapter was added or removed without updating the site's agent pages",
  );
});

test("each agent page quotes the source its adapter actually reads", () => {
  for (const page of AGENT_PAGES) {
    const adapter = adapters.find((a) => a.id === page.key);
    assert.ok(adapter, `no adapter for ${page.key}`);
    assert.equal(
      page.source,
      adapter.source,
      `${page.key}: the page's source path has drifted from the adapter's`,
    );
  }
});

test("the unsupported list names exactly the agents core cannot count", () => {
  assert.deepEqual(
    UNSUPPORTED.map((u) => u.name).sort(),
    unsupportedNames,
    "an agent moved between supported and unsupported without the site following",
  );
});

test("no agent is listed as both supported and unsupported", () => {
  /* The specific failure this catches: Gemini kept its "cannot be counted" entry after gaining
     a real adapter, so the site advertised and disclaimed the same agent. */
  const pageNames = new Set(AGENT_PAGES.map((p) => p.name));
  for (const u of UNSUPPORTED) {
    assert.ok(!pageNames.has(u.name), `${u.name} is both supported and unsupported`);
  }
});

test("the board can filter by every supported agent", () => {
  const keys = new Set(BOARD_AGENTS.map((a) => a.key));
  for (const id of supportedIds) {
    assert.ok(keys.has(id), `the board has no filter for ${id}`);
  }
});

test("both READMEs list every supported agent and its source", async () => {
  /*
   * Checked by source path rather than by name: a path is verbatim from the adapter, so it
   * cannot be satisfied by a passing mention elsewhere in the file. This is the check that
   * would have failed the moment Gemini shipped.
   */
  for (const rel of ["README.md", join("packages", "cli", "README.md")]) {
    const text = await readFile(join(REPO, rel), "utf8");
    for (const adapter of adapters) {
      assert.ok(
        text.includes(adapter.source),
        `${rel} does not list ${adapter.name} (${adapter.source})`,
      );
    }
    for (const probe of unsupported) {
      assert.ok(text.includes(probe.name), `${rel} does not mention ${probe.name}`);
    }
  }
});

test("no user-facing prose still lists the old three agents", async () => {
  /*
   * The exact sentence shape that went stale, wherever it is written. It named three agents at
   * a time when there were four, in six places at once — the hero, the description shared by
   * both preview cards, the OG image, a profile's invite text, `init --help` and a README.
   */
  const files = [
    join("apps", "site", "components", "hero.tsx"),
    join("apps", "site", "app", "layout.tsx"),
    join("apps", "site", "app", "opengraph-image.tsx"),
    join("apps", "site", "app", "u", "[handle]", "page.tsx"),
    join("packages", "cli", "src", "help.ts"),
    join("packages", "mcp", "README.md"),
    "README.md",
    join("packages", "cli", "README.md"),
    "banner.html",
  ];

  for (const rel of files) {
    const text = await readFile(join(REPO, rel), "utf8");
    // Prose that enumerates agents and stops at OpenCode without naming Gemini.
    const stale = /Claude Code,?\s*(?:\*\*)?Codex(?:\*\*)?\s+and\s+(?:\*\*)?OpenCode/i.exec(text);
    assert.equal(stale, null, `${rel} still lists only three agents: ${JSON.stringify(stale?.[0])}`);
  }
});
