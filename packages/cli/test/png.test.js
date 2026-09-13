import assert from "node:assert/strict";
import { test } from "node:test";

import { PRESETS, readmeSnippet } from "../.build/png.js";

/** The rasteriser is optional; on a machine without it these render tests are skipped. */
const available = await import("@resvg/resvg-js").then(() => true).catch(() => false);

const CARD =
  '<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195" viewBox="0 0 495 195">' +
  '<rect width="495" height="195" fill="#ffffff"/>' +
  '<text x="20" y="60" font-family="ui-sans-serif, system-ui, sans-serif" font-size="28">@handle</text>' +
  "</svg>";

test("the README snippet links somewhere that exists for a local-only user", () => {
  /* Someone exporting a PNG locally may never have published a row, and a snippet pointing at
     a profile page that 404s is worse than one pointing at the homepage. */
  const local = readmeSnippet("card.png", "nobody", false);
  assert.match(local, /\]\(https:\/\/tokenchit\.app\)$/);
  assert.ok(!local.includes("/u/"), "no profile link for an unpublished handle");

  const published = readmeSnippet("card.png", "somebody", true);
  assert.match(published, /\]\(https:\/\/tokenchit\.app\/u\/somebody\)$/);
});

test("the snippet embeds the local file by relative path", () => {
  assert.match(readmeSnippet("cards/card.png", "x", false), /!\[[^\]]+\]\(\.\/cards\/card\.png\)/);
});

test("presets are a short, closed list", () => {
  // Deliberately not an editor. Three shapes, and the SVG for anyone who wants more.
  assert.deepEqual([...PRESETS], ["card", "square", "portrait"]);
});

test("rendering needs no network and no browser", { skip: !available }, async () => {
  const { toPng } = await import("../.build/png.js");
  const { png, width, height } = await toPng(CARD, { scale: 1 });

  // PNG magic number, so this is a real raster rather than an SVG passed through.
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(width, 495);
  assert.equal(height, 195);
});

test("scale multiplies the intrinsic width", { skip: !available }, async () => {
  const { toPng } = await import("../.build/png.js");
  const a = await toPng(CARD, { scale: 1 });
  const b = await toPng(CARD, { scale: 3 });

  assert.equal(b.width, a.width * 3);
  assert.equal(b.height, a.height * 3);
});

test("scale is clamped rather than trusted", { skip: !available }, async () => {
  const { toPng } = await import("../.build/png.js");
  const huge = await toPng(CARD, { scale: 999 });
  const tiny = await toPng(CARD, { scale: 0.01 });
  const nonsense = await toPng(CARD, { scale: Number.NaN });

  assert.equal(huge.width, 495 * 6, "clamped to 6");
  assert.equal(tiny.width, 495, "clamped to 1");
  assert.equal(nonsense.width, 495 * 2, "falls back to the default");
});

test("a preset pads the card rather than cropping it", { skip: !available }, async () => {
  const { toPng } = await import("../.build/png.js");
  const square = await toPng(CARD, { scale: 1, preset: "square" });
  const portrait = await toPng(CARD, { scale: 1, preset: "portrait" });

  assert.equal(square.width, square.height, "1:1");
  // Never smaller than the card plus its padding, so nothing is cut off.
  assert.ok(square.width >= 495 + 96);
  assert.ok(portrait.height > portrait.width, "4:5 is taller than it is wide");
  assert.ok(portrait.width >= 495 + 96);
});

test("empty and extreme content still render", { skip: !available }, async () => {
  const { toPng } = await import("../.build/png.js");

  const empty =
    '<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195"></svg>';
  const long =
    '<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195">' +
    `<text x="4" y="40" font-size="12">@${"a".repeat(120)}</text>` +
    '<text x="4" y="80" font-size="12">999,999,999,999 tokens</text></svg>';

  for (const svg of [empty, long]) {
    const { png } = await toPng(svg, { scale: 1 });
    assert.ok(png.length > 0);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  }
});

test("a missing rasteriser fails with a message a person can act on", async () => {
  /* Asserted on the source rather than by uninstalling the package: the failure has to name
     the fix, because a stack trace about a native module tells the user nothing. */
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/png.ts", import.meta.url), "utf8");

  assert.match(src, /optional @resvg\/resvg-js package/);
  assert.match(src, /npm i @resvg\/resvg-js/);
  assert.match(src, /SVG output is unaffected/);
});

test("nothing in the render path reaches the network", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/png.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const forbidden of [/\bfetch\s*\(/, /node:https?/, /loadSystemFonts:\s*false/]) {
    assert.ok(!forbidden.test(code), `render path must not use ${forbidden}`);
  }
  // Fonts come from the machine, never from a URL.
  assert.match(code, /loadSystemFonts:\s*true/);
});
