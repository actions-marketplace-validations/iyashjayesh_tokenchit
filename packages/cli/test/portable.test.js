import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "index.js");
const FIXTURE_HOME = join(HERE, "fixtures", "home");

/**
 * The `ledger --export` / `--import` surface, driven the way a user drives it.
 *
 * The merge arithmetic is proved in `packages/core/test/portable.test.js`. What is tested here
 * is everything the CLI adds around it: file permissions, the backup, preview-versus-apply,
 * exit codes, and the promise that a refused import leaves the ledger untouched. There was no
 * coverage at this level, which is how a world-readable backup of a deliberately 0600 ledger
 * got written.
 */

const ledgerWith = (origin, cells) => ({
  version: 2,
  since: "2026-01-01",
  updatedAt: "2026-01-01T00:00:00.000Z",
  origin,
  tz: "Europe/London",
  days: cells,
});

const cell = (digest, tokens) => ({ s: { [digest]: [tokens, 0, 0, 0] } });

async function sandbox(ledger) {
  const cwd = await mkdtemp(join(tmpdir(), "tokenchit-portable-"));
  const xdg = join(cwd, "cfg");
  await mkdir(join(xdg, "tokenchit"), { recursive: true });
  if (ledger) {
    await writeFile(join(xdg, "tokenchit", "ledger.json"), `${JSON.stringify(ledger)}\n`, {
      mode: 0o600,
    });
  }
  await writeFile(
    join(cwd, ".tokenchit.json"),
    JSON.stringify({
      handle: "canary",
      agents: ["claude-code"],
      output: "c.svg",
      layout: "default",
      theme: "auto",
    }),
  );
  return { cwd, xdg, ledgerPath: join(xdg, "tokenchit", "ledger.json") };
}

function cli(args, { cwd, xdg }) {
  return run(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: FIXTURE_HOME,
      USERPROFILE: FIXTURE_HOME,
      CLAUDE_CONFIG_DIR: "",
      XDG_CONFIG_HOME: xdg,
      NO_COLOR: "1",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** `execFile` rejects on a non-zero exit; this keeps the result either way. */
const attempt = async (args, box) => {
  try {
    const { stdout, stderr } = await cli(args, box);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
};

const mode = async (path) => (await stat(path)).mode & 0o777;

test("an export is written 0600 and carries no identifiers", async () => {
  const box = await sandbox(
    ledgerWith("mine", { "2026-08-01": { "claude-code": { opus: cell("aaaaaaaaaaaa", 1234) } } }),
  );
  const out = join(box.cwd, "out.json");

  const { code } = await attempt(["ledger", "--export", out], box);
  assert.equal(code, 0);

  /* The same 0600 the ledger itself gets. It is the same data — a record of when somebody
     works and how hard — and a default-umask 0644 would publish it to every account on a
     shared box. */
  assert.equal(await mode(out), 0o600, "export must not be world-readable");

  const envelope = JSON.parse(await readFile(out, "utf8"));
  assert.equal(envelope.format, "tokenchit-ledger-export");
  assert.deepEqual(
    Object.keys(envelope).sort(),
    ["accounting", "coverage", "days", "exportedAt", "format", "origin", "since", "tz", "version"],
  );

  const text = JSON.stringify(envelope);
  for (const forbidden of ["/Users/", "/home/", "auth", "avatar", "handle", "canary", "apiKey"]) {
    assert.ok(!text.includes(forbidden), `export leaked ${forbidden}`);
  }
});

test("exporting an empty ledger says so rather than writing a hollow file", async () => {
  const box = await sandbox(null);
  const out = join(box.cwd, "out.json");
  const { code, stderr } = await attempt(["ledger", "--export", out], box);
  assert.equal(code, 1);
  assert.match(`${stderr}`, /no history to export/i);
  await assert.rejects(stat(out), "nothing should have been written");
});

test("import previews without writing, and applies only when asked", async () => {
  const theirs = await sandbox(
    ledgerWith("theirs", { "2026-08-02": { "claude-code": { opus: cell("bbbbbbbbbbbb", 2000) } } }),
  );
  const file = join(theirs.cwd, "theirs.json");
  await attempt(["ledger", "--export", file], theirs);

  const mine = await sandbox(
    ledgerWith("mine", { "2026-08-01": { "claude-code": { opus: cell("aaaaaaaaaaaa", 1000) } } }),
  );
  const before = await readFile(mine.ledgerPath, "utf8");

  const preview = await attempt(["ledger", "--import", file], mine);
  assert.equal(preview.code, 0);
  assert.match(preview.stdout, /Preview/);
  assert.match(preview.stdout, /Nothing was written/);
  assert.equal(await readFile(mine.ledgerPath, "utf8"), before, "a preview must not write");

  const applied = await attempt(["ledger", "--import", file, "--apply"], mine);
  assert.equal(applied.code, 0);
  assert.match(applied.stdout, /ledger updated/);
  assert.notEqual(await readFile(mine.ledgerPath, "utf8"), before);

  // Re-applying the same file is a no-op, and says so rather than reporting a merge.
  const again = await attempt(["ledger", "--import", file, "--apply"], mine);
  assert.match(again.stdout, /Nothing to do/);
});

test("an applied import leaves a recoverable backup, at the ledger's own permissions", async () => {
  const theirs = await sandbox(
    ledgerWith("theirs", { "2026-08-02": { "claude-code": { opus: cell("bbbbbbbbbbbb", 2000) } } }),
  );
  const file = join(theirs.cwd, "theirs.json");
  await attempt(["ledger", "--export", file], theirs);

  const mine = await sandbox(
    ledgerWith("mine", { "2026-08-01": { "claude-code": { opus: cell("aaaaaaaaaaaa", 1000) } } }),
  );
  const before = await readFile(mine.ledgerPath, "utf8");

  await attempt(["ledger", "--import", file, "--apply"], mine);

  const backup = mine.ledgerPath.replace(/\.json$/, ".backup.json");
  /* `copyFile` creates the destination under the umask, which produced a world-readable 0644
     backup of a deliberately 0600 ledger — the same data, republished. */
  assert.equal(await mode(backup), 0o600, "backup must not be world-readable");
  assert.equal(await readFile(backup, "utf8"), before, "backup holds the pre-import state");
});

test("every refusal exits 1 and leaves the ledger byte-identical", async () => {
  const box = await sandbox(
    ledgerWith("mine", { "2026-08-01": { "claude-code": { opus: cell("aaaaaaaaaaaa", 1000) } } }),
  );
  const before = await readFile(box.ledgerPath, "utf8");

  const write = async (name, body) => {
    const p = join(box.cwd, name);
    await writeFile(p, typeof body === "string" ? body : JSON.stringify(body));
    return p;
  };

  const good = {
    format: "tokenchit-ledger-export",
    version: 1,
    accounting: 2,
    exportedAt: "2026-09-13T00:00:00.000Z",
    origin: "them",
    tz: "UTC",
    since: "2026-01-01",
    coverage: { first: null, last: null, days: 0, tokens: 0 },
    days: {},
  };

  const refusals = [
    ["missing file", join(box.cwd, "nope.json")],
    ["not JSON", await write("bad1.json", "{oops")],
    ["wrong format", await write("bad2.json", { ...good, format: "something-else" })],
    ["newer envelope", await write("bad3.json", { ...good, version: 99 })],
    ["other accounting", await write("bad4.json", { ...good, accounting: 99 })],
    ["malformed day key", await write("bad5.json", { ...good, days: { nope: {} } })],
    [
      "poisoned agent key",
      await write(
        "bad6.json",
        '{"format":"tokenchit-ledger-export","version":1,"accounting":2,"exportedAt":"x",' +
          '"origin":"e","tz":"UTC","since":"2026-01-01","coverage":{},' +
          '"days":{"2026-08-01":{"__proto__":{"opus":{"s":{"aaaaaa":[1,0,0,0]}}}}}}',
      ),
    ],
  ];

  for (const [name, path] of refusals) {
    const r = await attempt(["ledger", "--import", path, "--apply"], box);
    assert.equal(r.code, 1, `${name} should exit 1`);
    assert.equal(
      await readFile(box.ledgerPath, "utf8"),
      before,
      `${name} must leave the ledger untouched`,
    );
  }
});

test("--json reports the preview without writing", async () => {
  const theirs = await sandbox(
    ledgerWith("theirs", { "2026-08-02": { "claude-code": { opus: cell("bbbbbbbbbbbb", 2000) } } }),
  );
  const file = join(theirs.cwd, "theirs.json");
  await attempt(["ledger", "--export", file], theirs);

  const mine = await sandbox(
    ledgerWith("mine", { "2026-08-01": { "claude-code": { opus: cell("aaaaaaaaaaaa", 1000) } } }),
  );
  const before = await readFile(mine.ledgerPath, "utf8");

  const { code, stdout } = await attempt(["ledger", "--import", file, "--json"], mine);
  assert.equal(code, 0);

  const payload = JSON.parse(stdout);
  assert.equal(payload.applied, false);
  assert.equal(payload.before.tokens, 1000);
  assert.equal(payload.after.tokens, 3000);
  assert.equal(payload.sources.added, 1);
  assert.equal(await readFile(mine.ledgerPath, "utf8"), before);
});

/* ---------------------------------------------------------------- *
 * Output that nobody is reading any more
 * ---------------------------------------------------------------- */

test("closing the output pipe early is not an error", async () => {
  /*
   * `tokenchit ledger | head -3` is an ordinary thing to type, and `head` closes the pipe as
   * soon as it has its three lines. Every later write then failed with EPIPE, which Node raises
   * as an unhandled `error` event — so a standard Unix idiom ended in a crash dump and a
   * non-zero exit, and `| less` did the same to anyone who quit early.
   *
   * It only bit commands that do asynchronous work *between* writes, which is why it looked
   * intermittent: a `--json` command scans first and writes once, so its single write lands in
   * the pipe buffer before the reader is gone.
   */
  const { spawn } = await import("node:child_process");
  const box = await sandbox(
    ledgerWith("mine", { "2026-08-01": { "claude-code": { opus: cell("aaaaaaaaaaaa", 1000) } } }),
  );

  for (const args of [["ledger"], ["doctor"]]) {
    const stderr = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: box.cwd,
        env: {
          ...process.env,
          HOME: FIXTURE_HOME,
          USERPROFILE: FIXTURE_HOME,
          CLAUDE_CONFIG_DIR: "",
          XDG_CONFIG_HOME: box.xdg,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let err = "";
      child.stderr.on("data", (d) => (err += d));
      // Read one chunk, then close — exactly what `head -1` does.
      child.stdout.once("data", () => child.stdout.destroy());
      child.on("close", () => resolve(err));
    });

    assert.ok(!stderr.includes("EPIPE"), `${args[0]} crashed on a closed pipe:\n${stderr}`);
    assert.ok(!stderr.includes("Unhandled"), `${args[0]} raised an unhandled error:\n${stderr}`);
  }
});

/* ---------------------------------------------------------------- *
 * The one direction that is not safe
 * ---------------------------------------------------------------- */

test("migrating a v1 ledger says so, once, and names the way out", async () => {
  /*
   * Upgrading is lossless. Going back a version is not, and nothing in this code can change
   * what an older build does: it reads a v2 ledger as unrecognised, falls back to an empty bank
   * and rewrites it from whatever logs are still on disk — destroying the one piece of state
   * here that cannot be re-derived.
   *
   * That warning lived only in an internal design note, where no user would ever meet it.
   */
  const v1 = {
    version: 1,
    since: "2026-01-01",
    updatedAt: "2026-01-01T00:00:00.000Z",
    days: { "2026-05-01": { "claude-code": { opus: [1_000_000, 50_000, 0, 0] } } },
  };

  const box = await sandbox(null);
  await writeFile(box.ledgerPath, `${JSON.stringify(v1)}\n`, { mode: 0o600 });

  /* Both streams: `warn` writes to stderr, which is what keeps `--json` pipeable, while the
     lines naming the fix are ordinary output. A reader at a terminal sees one message. */
  const said = (r) => `${r.stdout}${r.stderr}`;

  const first = await attempt(["ledger"], box);
  assert.match(said(first), /upgraded to the v2 format/i, "the upgrade was not mentioned");
  assert.match(said(first), /--export/, "the way to keep a recoverable copy was not named");

  // Reading does not write, so the file is still v1 and the hazard still stands.
  assert.equal(JSON.parse(await readFile(box.ledgerPath, "utf8")).version, 1);
  const second = await attempt(["ledger"], box);
  assert.match(said(second), /upgraded to the v2 format/i, "still v1 on disk, so still warn");

  // Exporting is enough to make the rollback safe, and works on the migrated view.
  const out = join(box.cwd, "safety-copy.json");
  assert.equal((await attempt(["ledger", "--export", out], box)).code, 0);

  // Once something writes, the file is v2 and the notice stops.
  const migrated = { ...v1, version: 2, origin: "mine", tz: "UTC", days: {} };
  await writeFile(box.ledgerPath, `${JSON.stringify(migrated)}\n`, { mode: 0o600 });
  const third = await attempt(["ledger"], box);
  assert.doesNotMatch(said(third), /upgraded to the v2 format/i, "the notice repeated on a v2 file");
});

test("the migration marker is never written to disk", async () => {
  /* It is a signal to one run, not a fact about the file. Persisting it would repeat the notice
     forever and leave a meaningless key in everybody's ledger. */
  const { adopt, writeLedger, readLedger } = await import("@tokenchit/core/adapters");

  const led = adopt({
    version: 1,
    since: "2026-01-01",
    days: { "2026-05-01": { "claude-code": { opus: [100, 0, 0, 0] } } },
  });
  assert.equal(led.migratedFrom, 1, "adopt did not flag the migration");

  const box = await sandbox(null);
  await writeLedger(led, box.ledgerPath);

  assert.ok(
    !(await readFile(box.ledgerPath, "utf8")).includes("migratedFrom"),
    "the transient marker was persisted",
  );
  assert.equal((await readLedger(box.ledgerPath)).migratedFrom, undefined);
});
