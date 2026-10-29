// box, reached as devbox: runs in LXD `dev` from dogchef folders only. A stub lxc prints its arguments.
// Run: node --test nucbox/tests/box.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const box = fileURLToPath(new URL("../box", import.meta.url));

function setup() {
  const home = mkdtempSync(join(tmpdir(), "bx-"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin/lxc"), '#!/bin/sh\necho "lxc $*"\n', { mode: 0o755 });
  for (const n of ["devbox", "dogchefbox", "other"]) symlinkSync(box, join(home, "bin", n));
  mkdirSync(join(home, "projects/dogchef/dev"), { recursive: true });
  mkdirSync(join(home, "plain"));
  const dogRepo = join(home, "wt");
  mkdirSync(dogRepo);
  execFileSync("git", ["-C", dogRepo, "init", "-q"]);
  execFileSync("git", ["-C", dogRepo, "remote", "add", "origin", "git@github.com:dogchef-be/dev.git"]);
  const run = (name, cwd, ...args) =>
    spawnSync(join(home, "bin", name), args, { cwd, encoding: "utf8", env: { ...process.env, PROJECTS_DIR: undefined, HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}` } });
  return { home, dogRepo, run, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("devbox runs in `dev` from ~/projects/dogchef and from a dogchef-be worktree, same cwd", () => {
  const t = setup();
  try {
    for (const cwd of [join(t.home, "projects/dogchef/dev"), t.dogRepo]) {
      const r = t.run("devbox", cwd, "make", "up");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^lxc exec dev --cwd ${cwd} -- sudo -u fabio -H bash -lc .*GRAPHIFY_SKIP_HOOK=1.* ${cwd} make up\n$`));
    }
  } finally { t.done(); }
});

test("devbox in a folder that is not dogchef exits 2 and never calls lxc", () => {
  const t = setup();
  try {
    const r = t.run("devbox", join(t.home, "plain"), "true");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /devbox runs dogchef folders only/);
    assert.equal(r.stdout, "");
  } finally { t.done(); }
});

test("any other name, dogchefbox included, exits 64", () => {
  const t = setup();
  try {
    for (const n of ["dogchefbox", "other"]) {
      const r = t.run(n, join(t.home, "projects/dogchef/dev"), "true");
      assert.equal(r.status, 64, n);
      assert.equal(r.stdout, "");
    }
  } finally { t.done(); }
});

test("DEVBOX_INSTANCE overrides the instance", () => {
  const t = setup();
  try {
    const r = spawnSync(join(t.home, "bin/devbox"), ["true"], { cwd: join(t.home, "projects/dogchef/dev"), encoding: "utf8", env: { ...process.env, PROJECTS_DIR: undefined, HOME: t.home, PATH: `${join(t.home, "bin")}:${process.env.PATH}`, DEVBOX_INSTANCE: "x" } });
    assert.match(r.stdout, /^lxc exec x /);
  } finally { t.done(); }
});

test("without is-business-dir.sh next to it, it exits 70 and runs nothing", () => {
  const t = setup();
  try {
    const dir = join(t.home, "lone");
    mkdirSync(dir);
    copyFileSync(box, join(dir, "box"));
    symlinkSync(join(dir, "box"), join(dir, "devbox"));
    const r = spawnSync(join(dir, "devbox"), ["true"], { cwd: join(t.home, "plain"), encoding: "utf8", env: { ...process.env, PROJECTS_DIR: undefined, HOME: t.home, PATH: `${join(t.home, "bin")}:${process.env.PATH}` } });
    assert.equal(r.status, 70);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /is-business-dir\.sh missing/);
  } finally { t.done(); }
});
