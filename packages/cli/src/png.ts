/**
 * Local raster export for the cards this tool already renders as SVG.
 *
 * The SVG stays the primary artifact: it is what belongs in a README, it is what GitHub serves
 * without going through camo, and it is a file rather than a URL. A PNG is for the places that
 * will not take an SVG — a social post, a slide, a chat window.
 *
 * Three things this deliberately is not:
 *
 * - **Not a screenshot.** No browser, no headless Chrome, no hosted renderer. The SVG this
 *   package already produces is rasterised in-process.
 * - **Not networked.** Nothing is fetched while rendering. The card's fonts are plain
 *   `font-family` fallbacks precisely because GitHub strips webfont references from README
 *   SVGs, so there is nothing to load, and no image is referenced by URL.
 * - **Not an editor.** A short list of presets, and the existing `hide`/`layout`/`theme`
 *   concepts. Anyone wanting pixel control has the SVG.
 *
 * The rasteriser is an *optional* dependency, imported lazily inside `toPng`. `sync`,
 * `publish`, `recap` and the MCP server never touch it, so a machine that cannot build a
 * native module still has a fully working CLI — it simply cannot write a PNG, and is told so
 * in a sentence that names the fix.
 */

/** Padding round the card, in card pixels, so a shared image is not edge-to-edge. */
const PAD = 48;

export type Preset = "card" | "square" | "portrait";

export const PRESETS: readonly Preset[] = ["card", "square", "portrait"];

/**
 * Aspect ratios worth having, and no more.
 *
 * `card` is the artwork's own shape, scaled. The other two matter because a 495x195 card
 * posted to a feed that crops to a square loses its own edges; padding it into the target
 * shape means the crop happens here, deliberately, rather than wherever it lands.
 */
const SHAPES: Record<Preset, { ratio: number | null; label: string }> = {
  card: { ratio: null, label: "the card's own shape" },
  square: { ratio: 1, label: "1:1, for feeds that crop to a square" },
  portrait: { ratio: 4 / 5, label: "4:5, the tallest most feeds show uncropped" },
};

export type PngOptions = {
  /** Multiplier on the SVG's intrinsic width. 2 is a reasonable default for retina. */
  scale?: number;
  preset?: Preset;
  /** Background behind the card when a preset pads it out. */
  background?: string;
};

export type PngResult = { png: Buffer; width: number; height: number };

/**
 * Rasterise an SVG string.
 *
 * Throws a message meant to be printed verbatim when the optional rasteriser is missing: a
 * stack trace about a native module tells the user nothing they can act on.
 */
export async function toPng(svg: string, opts: PngOptions = {}): Promise<PngResult> {
  const scale = clampScale(opts.scale ?? 2);
  const preset = opts.preset ?? "card";
  const background = opts.background ?? "#FFFDF9";

  let Resvg: typeof import("@resvg/resvg-js").Resvg;
  try {
    ({ Resvg } = await import("@resvg/resvg-js"));
  } catch {
    throw new Error(
      "PNG export needs the optional @resvg/resvg-js package, which is not installed here.\n" +
        "  Install it beside the CLI:  npm i @resvg/resvg-js\n" +
        "  SVG output is unaffected and needs nothing extra.",
    );
  }

  const framed = preset === "card" ? svg : frame(svg, SHAPES[preset].ratio as number, background);

  const resvg = new Resvg(framed, {
    // Width-driven, so the caller's scale means one predictable thing.
    fitTo: { mode: "width", value: Math.round(intrinsicWidth(framed) * scale) },
    /* System fonts only, and no remote loading. The card names font *stacks* rather than one
       face, so this resolves the same way a browser would on the same machine. */
    font: { loadSystemFonts: true },
    background,
  });

  const rendered = resvg.render();
  return { png: Buffer.from(rendered.asPng()), width: rendered.width, height: rendered.height };
}

/** 1 to 6. Below 1 the text stops being legible; above 6 the file is large for no gain. */
function clampScale(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.min(6, Math.max(1, n));
}

const intrinsicWidth = (svg: string): number => {
  const m = /\bwidth="(\d+(?:\.\d+)?)"/.exec(svg);
  return m ? Number(m[1]) : 495;
};

const intrinsicHeight = (svg: string): number => {
  const m = /\bheight="(\d+(?:\.\d+)?)"/.exec(svg);
  return m ? Number(m[1]) : 195;
};

/**
 * Centre the card inside a new canvas of the requested ratio.
 *
 * Done by wrapping rather than re-rendering: the card's own SVG is nested untouched, so a
 * preset cannot change what the card says or how it is laid out. It only decides how much
 * space surrounds it.
 */
function frame(svg: string, ratio: number, background: string): string {
  const w = intrinsicWidth(svg);
  const h = intrinsicHeight(svg);

  const innerW = w + PAD * 2;
  const innerH = h + PAD * 2;

  // Grow whichever axis falls short of the ratio; never shrink, or the card would crop.
  const targetW = Math.max(innerW, Math.round(innerH * ratio));
  const targetH = Math.max(innerH, Math.round(targetW / ratio));

  const x = Math.round((targetW - w) / 2);
  const y = Math.round((targetH - h) / 2);

  /* The inner SVG keeps its own width and height, so it is placed at natural size rather than
     stretched. `<svg>` nesting is SVG 1.1 and resvg supports it; an <image> href would have
     meant a data: URI round-trip or a file read at render time. */
  const inner = svg.replace(/^<svg /, `<svg x="${x}" y="${y}" `);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${targetW}" height="${targetH}" ` +
    `viewBox="0 0 ${targetW} ${targetH}">` +
    `<rect width="${targetW}" height="${targetH}" fill="${background}"/>` +
    inner +
    `</svg>`
  );
}

/** One line per preset, for `--help`. */
export const presetHelp = (): string => PRESETS.map((p) => `${p} — ${SHAPES[p].label}`).join("; ");

/**
 * A README snippet for a locally generated card.
 *
 * Links to the project homepage unless the handle is actually published. Someone exporting a
 * PNG locally may never have joined the board, and a snippet pointing at a profile that does
 * not exist is worse than one pointing somewhere real.
 */
export function readmeSnippet(file: string, handle: string, published: boolean): string {
  const href = published ? `https://tokenchit.app/u/${handle}` : "https://tokenchit.app";
  return `[![tokenchit — @${handle} AI coding agent usage](./${file})](${href})`;
}
