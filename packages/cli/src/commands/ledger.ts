import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { formatTokens, localDay } from "@tokenchit/core";
import {
  backupPath,
  buildExport,
  foreignHistory,
  LIMITS,
  ledgerPath,
  ledgerSummary,
  mergeExport,
  readLedger,
  validateExport,
  withLedgerLock,
  writeLedger,
  type ImportPreview,
} from "@tokenchit/core/adapters";

import { flag, has } from "../args.js";
import { DEFAULT_CONFIG, readConfig } from "../config.js";
import { scan } from "../scan.js";
import { bold, dim, fail, green, grey, say, spin, warn, yellow } from "../ui.js";

/**
 * Show, or rebuild, the local history bank.
 *
 * The ledger is the one piece of state this tool keeps that cannot be re-derived — that is
 * the entire point of it — so it needs a way to be looked at. Someone whose total moves has a
 * right to see what is behind it without reading JSON.
 */
export async function ledger(argv: string[]): Promise<number> {
  /*
   * Three verbs share this command, and each used to win by being checked first — so
   * `--export a --import b` exported and silently ignored the import, and `--rebuild --export`
   * rebuilt and wrote no file. A verb the user typed must never be dropped in silence: this is
   * the one command here that can destroy history, and "I thought it had imported" is exactly
   * the misunderstanding that costs somebody their ledger.
   */
  const verbs = (["--rebuild", "--export", "--import"] as const).filter((f) => has(argv, f));
  if (verbs.length > 1) {
    throw new Error(`${verbs.join(" and ")} each do a different thing to the ledger. Pick one.`);
  }

  // `--apply` is a qualifier on `--import`, and on its own it silently did nothing at all.
  if (has(argv, "--apply") && !has(argv, "--import")) {
    throw new Error("--apply commits a previewed import; it needs --import <file> to apply.");
  }

  if (has(argv, "--rebuild")) return rebuild(argv);

  const exportTo = flag(argv, "--export");
  if (exportTo !== undefined) return exportLedger(exportTo, has(argv, "--json"));

  const importFrom = flag(argv, "--import");
  if (importFrom !== undefined) {
    return importLedger(importFrom, has(argv, "--apply"), has(argv, "--json"));
  }

  const path = ledgerPath();
  const current = await readLedger();
  const s = ledgerSummary(current);

  if (s.days === 0) {
    say();
    say(`  ${bold("Nothing banked yet.")} ${grey("Run")} ${bold("tokenchit sync")} ${grey("to start.")}`);
    say(dim(`  It would live at ${path}`));
    say();
    return 0;
  }

  say();
  say(`  ${bold(formatTokens(s.tokens))} ${grey("banked across")} ${bold(String(s.days))} ${grey("days")}`);
  say(`  ${grey(`${s.first} → ${s.last} · ${s.agents.join(", ")}`)}`);
  say();
  // Both as local days. `since` is written by localDay while updatedAt is an ISO instant, so
  // slicing the latter showed yesterday's date to anyone east of UTC after midnight.
  say(dim(`  since ${current.since} · updated ${localDay(new Date(current.updatedAt))}`));
  say(dim(`  ${path}`));
  say();
  say(`  ${grey("This is history your agent logs may no longer hold. It is never uploaded")}`);
  say(`  ${grey("on its own — it only makes the totals you publish complete.")}`);
  say();
  for (const f of foreignHistory(current)) {
    /* Named rather than hidden. This is somebody's real history sitting in the file and not
       being counted, and a total that silently ignores data the user knows they imported is
       the one thing worse than a total that explains itself. */
    say(
      `  ${grey("held, not counted")}  ${formatTokens(f.tokens)} across ${f.days} ` +
        `${f.days === 1 ? "day" : "days"} ${dim(`(${f.first} → ${f.last})`)}`,
    );
    say(dim(`    from ${f.origin.slice(0, 8)} · no session identities, so it cannot be told`));
    say(dim("    apart from work already counted here"));
  }
  if (foreignHistory(current).length > 0) say();

  say(dim("  --export <file>   write a portable copy of this history"));
  say(dim("  --import <file>   preview merging one in; add --apply to commit it"));
  say(dim("  --rebuild         discard it and re-derive from the logs still on disk"));
  say();
  return 0;
}

/**
 * Throw the bank away and start again from what is on disk.
 *
 * The escape hatch for the one real hazard of a max-wins bank: a reading that was wrong high
 * is otherwise kept forever. It is genuinely destructive — days the logs no longer cover are
 * gone for good, which is exactly the history the ledger existed to protect — so it states
 * what will be lost and requires `--yes` rather than a prompt, because a prompt is not
 * available in the cron job where this is most likely to be typed by mistake.
 */
async function rebuild(argv: string[]): Promise<number> {
  const path = ledgerPath();

  /* Read the config before the warning, not after. The rebuild only re-derives the agents this
     repo's config names, so those are the only agents it may clear — and the warning has to
     quote that same scope or it describes a different operation than the one about to run. */
  const config = (await readConfig()) ?? DEFAULT_CONFIG;
  const ledger = await readLedger();
  const before = ledgerSummary(ledger, config.agents);
  const whole = ledgerSummary(ledger);

  if (!has(argv, "--yes")) {
    const scoped = config.agents.length > 0 && before.agents.length < whole.agents.length;
    say();
    warn(
      scoped
        ? `This discards ${formatTokens(before.tokens)} across ${before.days} banked days for ${before.agents.join(", ")}.`
        : `This discards ${formatTokens(before.tokens)} across ${before.days} banked days.`,
    );
    say(dim(`  Days your logs no longer cover cannot be recovered afterwards.`));
    if (scoped) {
      // Naming what survives is as important as naming what goes: the bank is global to the
      // machine while this config is not, and that mismatch is the whole hazard here.
      const safe = whole.agents.filter((a) => !before.agents.includes(a));
      say(dim(`  ${safe.join(", ")} ${safe.length === 1 ? "is" : "are"} not in this repo's config and will be left alone.`));
    }
    say();
    say(`  ${grey("If that is what you want:")} ${bold("tokenchit ledger --rebuild --yes")}`);
    say();
    return 1;
  }

  const reading = spin("re-reading local agent logs…");
  const { stats } = await scan(config.agents, {
    fresh: true,
    onProgress: ({ agent, events }) =>
      reading.update(events === 0 ? `reading ${agent}…` : `reading ${agent}… ${events.toLocaleString()} events`),
  });
  reading.stop();

  if (stats.tokens === 0) {
    /*
     * Nothing was read, so nothing was banked. Leaving a stale file would be worse than an
     * empty one, but so would silently reporting success.
     *
     * Only remove the file when the bank is empty for every agent. A scoped rebuild that reads
     * nothing must not delete the days it deliberately preserved for the agents it never
     * touched — that would undo the scoping this command now does and lose exactly the history
     * the warning above promised to leave alone.
     */
    const remaining = ledgerSummary(await readLedger());
    if (remaining.tokens === 0) {
      await rm(path, { force: true }).catch(() => {});
      fail("No usage found — the ledger is now empty.");
    } else {
      fail(
        `No usage found for ${config.agents.length ? config.agents.join(", ") : "any configured agent"} — ` +
          `${formatTokens(remaining.tokens)} banked for ${remaining.agents.join(", ")} is untouched.`,
      );
    }
    return 1;
  }

  const after = ledgerSummary(await readLedger(), config.agents);
  say();
  say(`${green("✓")} rebuilt from the logs on disk`);
  say(
    dim(
      `  ${before.days} days (${formatTokens(before.tokens)})  →  ` +
        `${after.days} days (${formatTokens(after.tokens)})`,
    ),
  );
  say();
  return 0;
}


/**
 * Write a portable copy of this machine's history.
 *
 * Reads the ledger and writes a new file; the live bank is never touched, which is what makes
 * this safe to run at any time, including while a sync is walking the logs.
 *
 * What travels is normalised usage plus the minimum needed to interpret it: accounting
 * version, the ledger's random origin label, the zone its days were binned in, and the
 * coverage dates. What does not travel is everything else — no auth state, no raw logs, no
 * prompts or replies, no repository names, no filesystem paths hashed or otherwise. Session
 * identities are truncated digests, so the file cannot be matched against the log filenames on
 * anybody's disk.
 */
async function exportLedger(out: string, json: boolean): Promise<number> {
  if (!out) throw new Error("--export needs a file to write to, e.g. --export ~/tokenchit.json");

  const current = await readLedger();
  const s = ledgerSummary(current);
  if (s.days === 0) {
    warn("Nothing banked yet — there is no history to export.");
    return 1;
  }

  const envelope = buildExport(current);
  const target = resolve(process.cwd(), out);

  /*
   * Wrapped, for the same reason `sync --out` wraps its write.
   *
   * A bare errno names the recursive mkdir's first failure point — a path the user never typed
   * — mentions neither the flag nor what was asked for, and offers no next step:
   * `--export /nope/deeper/x.json` reported `ENOENT: no such file or directory, mkdir '/nope'`.
   */
  try {
    await mkdir(dirname(target), { recursive: true });
    // 0600 like the ledger itself. This is a record of when somebody works and how hard.
    await writeFile(target, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why =
      code === "EACCES" || code === "EPERM"
        ? "no permission to write there"
        : code === "ENOENT"
          ? "that directory does not exist and could not be created"
          : ((err as Error).message ?? String(err));
    throw new Error(`could not write --export ${target}: ${why}`);
  }

  const bytes = (await stat(target)).size;
  if (json) {
    say(JSON.stringify({ wrote: target, bytes, coverage: envelope.coverage }, null, 2));
    return 0;
  }

  const rel = relative(process.cwd(), target);
  say();
  say(`${green("\u2713")} wrote ${bold(rel)} ${dim(`(${bytes.toLocaleString()} bytes, mode 0600)`)}`);
  say(
    dim(
      `  ${formatTokens(s.tokens)} across ${s.days} ${s.days === 1 ? "day" : "days"}` +
        (s.first ? ` · ${s.first} → ${s.last}` : ""),
    ),
  );
  say();
  say(`  ${grey("Usage only. No credentials, no transcripts, no paths, no repository names.")}`);
  say(`  ${grey("On the other machine:")} ${bold(`tokenchit ledger --import ${rel}`)}`);
  say();
  return 0;
}

/**
 * Merge another machine's history in — after showing exactly what that would do.
 *
 * Preview is the default and `--apply` is the opt-in, because this writes to the one piece of
 * state here that cannot be re-derived. The preview runs the real merge against the real
 * ledger and reports the real difference; it simply does not write the result.
 */
async function importLedger(from: string, apply: boolean, json: boolean): Promise<number> {
  if (!from) throw new Error("--import needs a file to read, e.g. --import ~/tokenchit.json");

  const source = resolve(process.cwd(), from);
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) {
    fail(`no such file: ${source}`);
    return 1;
  }
  /* Checked before reading rather than after. A ledger export is kilobytes; refusing to pull a
     gigabyte into memory to discover it was the wrong file is cheaper than finding out. */
  if (info.size > LIMITS.bytes) {
    fail(`${relative(process.cwd(), source)} is ${(info.size / 1e6).toFixed(1)} MB — far larger than any ledger export.`);
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(source, "utf8"));
  } catch (err) {
    fail(`could not read ${relative(process.cwd(), source)} as JSON: ${(err as Error).message}`);
    return 1;
  }

  const checked = validateExport(parsed);
  if (!checked.ok) {
    say();
    fail(`${relative(process.cwd(), source)} cannot be imported.`);
    for (const line of checked.errors) say(dim(`  ${line}`));
    say();
    say(`  ${grey("Your ledger has not been touched.")}`);
    say();
    return 1;
  }

  const path = ledgerPath();

  /*
   * Both halves run inside the lock.
   *
   * A preview outside it would describe a ledger that a concurrent sync had already moved on
   * from, and an apply outside it could overwrite that sync entirely. Holding it for the
   * preview too costs milliseconds and means the numbers printed are the numbers that were
   * true at the moment they were computed.
   */
  const result = await withLedgerLock(path, async () => {
    const live = await readLedger(path);
    const { ledger: merged, preview } = mergeExport(live, checked.value);
    if (!apply || !preview.changed) return { preview, wrote: false, backup: null as string | null };

    /* A recoverable copy first, and only then the rename. An interrupted apply therefore
       leaves either the untouched original or the original plus a backup — never a ledger
       that is half of each. */
    let backup: string | null = null;
    if (await stat(path).then(() => true).catch(() => false)) {
      backup = backupPath(path);
      await copyLedgerFile(path, backup);
    }
    await writeLedger(merged, path);
    return { preview, wrote: true, backup };
  });

  if (json) {
    say(JSON.stringify({ applied: result.wrote, backup: result.backup, ...result.preview }, null, 2));
    return 0;
  }

  report(result.preview, apply, result.wrote, result.backup, relative(process.cwd(), source));
  return 0;
}

function report(
  p: ImportPreview,
  apply: boolean,
  wrote: boolean,
  backup: string | null,
  source: string,
): void {
  const gained = p.after.tokens - p.before.tokens;

  say();
  say(`  ${bold(apply && wrote ? "Imported" : "Preview")} ${grey(source)}`);
  say(
    dim(
      `  from ${p.from.origin.slice(0, 8)} · exported ${p.from.exportedAt.slice(0, 10)} · ${p.from.tz}`,
    ),
  );
  say();

  say(
    `  ${grey("sessions")}   ${p.sources.incoming.toLocaleString()} in the file — ` +
      `${bold(p.sources.added.toLocaleString())} new, ` +
      `${p.sources.raised.toLocaleString()} fuller than what is here, ` +
      `${p.sources.unchanged.toLocaleString()} already held`,
  );
  say(
    `  ${grey("totals")}     ${formatTokens(p.before.tokens)} across ${p.before.days} days  ` +
      `${dim("\u2192")}  ${bold(formatTokens(p.after.tokens))} across ${bold(String(p.after.days))} days`,
  );
  if (gained > 0) {
    say(`  ${grey("gained")}     ${green(`+${formatTokens(gained)}`)} over ${p.newDayCount} new ${p.newDayCount === 1 ? "day" : "days"}`);
    if (p.newDays.length > 0) {
      say(dim(`             ${p.newDays.join(", ")}${p.newDayCount > p.newDays.length ? ", …" : ""}`));
    }
  }
  say();

  for (const w of p.warnings) say(warnLines(w));

  for (const f of p.notCounted) {
    say(
      `  ${grey("held, not counted")}  ${formatTokens(f.tokens)} across ${f.days} ` +
        `${f.days === 1 ? "day" : "days"} ${dim(`from ${f.origin.slice(0, 8)}`)}`,
    );
  }
  if (p.notCounted.length > 0) say();

  if (!p.changed) {
    say(`  ${bold("Nothing to do.")} ${grey("Every session in that file is already banked here.")}`);
    say();
    return;
  }

  /* An import can be worth applying and still move no total: history with no session
     identities is kept rather than counted. Saying "nothing changed" there would be wrong in
     the direction that loses data, so the outcome is named for what it actually is. */
  if (gained === 0 && p.held.after > p.held.before) {
    const kept = p.held.after - p.held.before;
    say(
      `  ${grey("This adds nothing to your totals.")} ${formatTokens(kept)} of history with no`,
    );
    say(`  ${grey("session identities is kept, in full, and reported separately.")}`);
    say();
  }

  if (apply && wrote) {
    say(`${green("\u2713")} ledger updated`);
    if (backup) say(dim(`  previous copy kept at ${backup}`));
    say();
    return;
  }

  say(`  ${grey("Nothing was written.")} ${grey("To merge this in:")}`);
  say(`  ${bold(`tokenchit ledger --import ${source} --apply`)}`);
  say();
}

/** Wrap a long explanation to the terminal without losing its indent. */
function warnLines(text: string): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > 74) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? `  ${yellow("!")} ${l}` : `    ${dim(l)}`)).join("\n");
}

/**
 * Copy the ledger aside, at the ledger's own permissions.
 *
 * `copyFile` creates the destination under the process umask, so the backup came out 0644
 * while the file it copies is deliberately 0600 — the same record of when somebody works and
 * how hard, republished to every account on a shared box. Written through a temporary file
 * created at 0600 and renamed into place, so the mode is right from the first byte and an
 * existing backup is replaced atomically rather than truncated and refilled.
 */
async function copyLedgerFile(from: string, to: string): Promise<void> {
  const body = await readFile(from);
  const tmp = `${to}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, to);
}
