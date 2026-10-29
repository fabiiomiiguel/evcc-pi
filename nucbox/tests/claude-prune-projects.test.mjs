// claude-prune-projects.sh over a temp HOME: removes the ~/.claude.json `projects` keys and the ~/.claude*/projects dirs whose
// folder no longer exists (backed up first), keeps the rest, --dry-run changes nothing, a re-run is a no-op.
// Run: node --test nucbox/tests/claude-prune-projects.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../claude-prune-projects.sh", import.meta.url));

function setup() {
  const home = mkdtempSync(join(tmpdir(), "cpp-"));
  const live = join(home, "projects/live");
  mkdirSync(live, { recursive: true });
  const gone = join(home, "projects/gone");
  const json = { numStartups: 3, projects: { [live]: { allowedTools: [] }, [gone]: { allowedTools: [] } } };
  for (const acct of [".claude", ".claude-business"]) {
    mkdirSync(join(home, acct, "projects"), { recursive: true });
    writeFileSync(join(home, acct === ".claude" ? ".claude.json" : `${acct}/.claude.json`), JSON.stringify(json));
    for (const [name, cwd] of [["live", live], ["gone", gone], ["nocwd", null]]) {
      const d = join(home, acct, "projects", `-${name}`);
      mkdirSync(d);
      writeFileSync(join(d, "s.jsonl"), cwd ? `{"type":"x"}\n{"cwd":"${cwd}"}\n` : `{"type":"x"}\n`);
    }
  }
  return { home, live, gone };
}
// a stub pgrep: the host's own claude sessions must not decide the verdict
const withPgrep = (home, code) => {
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin/pgrep"), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
  return { PATH: `${join(home, "bin")}:${process.env.PATH}`, HOME: home };
};
const run = (home, ...args) => spawnSync("bash", [script, ...args], { env: withPgrep(home, 1), encoding: "utf8" });
const keys = (home, f) => Object.keys(JSON.parse(readFileSync(join(home, f), "utf8")).projects);

test("dry-run prints the removals and changes nothing", () => {
  const { home, gone } = setup();
  const r = run(home, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(gone));
  assert.equal(keys(home, ".claude.json").length, 2);
  assert.ok(existsSync(join(home, ".claude/projects/-gone")));
});

test("live run removes only the keys and dirs of folders that no longer exist, after a backup", () => {
  const { home, live, gone } = setup();
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  for (const f of [".claude.json", ".claude-business/.claude.json"]) assert.deepEqual(keys(home, f), [live]);
  for (const a of [".claude", ".claude-business"]) {
    assert.ok(existsSync(join(home, a, "projects/-live")));
    assert.ok(existsSync(join(home, a, "projects/-nocwd")), "a dir with no recorded cwd is kept");
    assert.ok(!existsSync(join(home, a, "projects/-gone")));
  }
  assert.equal(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).numStartups, 3);
  const bk = readdirSync(join(home, "backup-claude-prune")).filter((f) => /^claude-\d+\.json$/.test(f));
  assert.equal(bk.length, 1, "json backup is timestamped");
  assert.match(readFileSync(join(home, "backup-claude-prune", bk[0]), "utf8"), new RegExp(gone));
  assert.ok(existsSync(join(home, "backup-claude-prune/claude/projects/-gone/s.jsonl")));
});

test("a second run changes nothing", () => {
  const { home } = setup();
  run(home);
  const before = readFileSync(join(home, ".claude.json"), "utf8");
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), before);
});

test("refuses while claude runs", () => {
  const { home } = setup();
  const r = spawnSync("bash", [script], { env: withPgrep(home, 0), encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /claude is running/);
  assert.equal(keys(home, ".claude.json").length, 2);
});

// after rename-projects.sh the session files still say /Projects/...; the folder lives at /projects/...
function renamed(home) {
  const d = join(home, ".claude/projects/-home-renamed");
  mkdirSync(d);
  writeFileSync(join(d, "s.jsonl"), `{"cwd":"${home}/Projects/live"}\n`);
  return d;
}

test("old-path cwd is kept while Projects is a symlink to projects", () => {
  const { home } = setup();
  symlinkSync("projects", join(home, "Projects"));
  const d = renamed(home);
  assert.equal(run(home).status, 0);
  assert.ok(existsSync(d));
});

test("old-path cwd is kept when Projects is gone and projects/ has the folder", () => {
  const { home } = setup();
  const d = renamed(home);
  assert.equal(run(home).status, 0);
  assert.ok(existsSync(d));
});

test("the json rewrite keeps mode and follows a symlinked json", () => {
  const { home } = setup();
  const real = join(home, "real.json");
  writeFileSync(real, readFileSync(join(home, ".claude.json")));
  chmodSync(real, 0o600);
  rmSync(join(home, ".claude.json"));
  symlinkSync(real, join(home, ".claude.json"));
  assert.equal(run(home).status, 0);
  assert.ok(lstatSync(join(home, ".claude.json")).isSymbolicLink());
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.equal(Object.keys(JSON.parse(readFileSync(real, "utf8")).projects).length, 1);
});
