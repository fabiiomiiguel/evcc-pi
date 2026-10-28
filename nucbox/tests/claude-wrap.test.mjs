// The claude wrapper picks CLAUDE_CONFIG_DIR by where it runs, then execs ~/.local/bin/claude (a stub printing it).
// Run: node --test nucbox/tests/claude-wrap.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wrap = fileURLToPath(new URL("../claude-wrap", import.meta.url));

const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home };
  for (const k of ["CLAUDE_WRAP_GUARD", "CLAUDE_WRAP_HOOK", "CLAUDE_WRAP_BYPASS", "CLAUDE_CONFIG_DIR", "PROJECTS_DIR"]) delete env[k];
  return { ...env, ...extra };
};

function setup() {
  const home = mkdtempSync(join(tmpdir(), "cw-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const real = join(home, ".local", "bin", "claude");
  writeFileSync(real, '#!/usr/bin/env bash\necho "real:${CLAUDE_CONFIG_DIR-unset}:$*"\n');
  chmodSync(real, 0o755);
  mkdirSync(join(home, "projects", "dogchef"), { recursive: true });
  const repo = (name, origin) => {
    const d = join(home, name);
    mkdirSync(d);
    execFileSync("git", ["-C", d, "init", "-q"]);
    execFileSync("git", ["-C", d, "remote", "add", "origin", origin]);
    return d;
  };
  const run = (cwd, extra = {}, args = ["a"]) => {
    const env = cleanEnv(home, extra);
    return execFileSync("bash", [wrap, ...args], { cwd, encoding: "utf8", env }).trim();
  };
  return { home, repo, run, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("dogchef-be origin gets the business dir", () => {
  const t = setup();
  try {
    const d = t.repo("wt", "git@github.com:dogchef-be/dev.git");
    assert.equal(t.run(d), `real:${t.home}/.claude-business:a`);
  } finally { t.done(); }
});

test("a non-git dir under DOGCHEF_DIR gets the business dir", () => {
  const t = setup();
  try {
    assert.equal(t.run(join(t.home, "projects", "dogchef")), `real:${t.home}/.claude-business:a`);
  } finally { t.done(); }
});

test("another origin leaves it unset", () => {
  const t = setup();
  try {
    assert.equal(t.run(t.repo("p", "git@github.com:me/x.git")), "real:unset:a");
  } finally { t.done(); }
});

test("CLAUDE_WRAP_GUARD=0 keeps the personal account in a dogchef repo; without it the same repo gets business", () => {
  const t = setup();
  try {
    const d = t.repo("wt", "git@github.com:dogchef-be/dev.git");
    assert.equal(t.run(d, { CLAUDE_WRAP_GUARD: "0" }), "real:unset:a");
    assert.equal(t.run(d), `real:${t.home}/.claude-business:a`);
  } finally { t.done(); }
});

test("a preset variable is kept", () => {
  const t = setup();
  try {
    const d = t.repo("wt", "git@github.com:dogchef-be/dev.git");
    assert.equal(t.run(d, { CLAUDE_CONFIG_DIR: "/x" }), "real:/x:a");
  } finally { t.done(); }
});

test("running from the wrapper dir does not loop", () => {
  const t = setup();
  try {
    const dir = join(t.home, ".local", "claude-wrap");
    mkdirSync(dir, { recursive: true });
    assert.equal(t.run(dir, { PATH: `${dir}:${process.env.PATH}` }, ["b"]), "real:unset:b");
  } finally { t.done(); }
});

test("without is-business-dir.sh: normal mode exits 70 and never runs claude, guard mode stays fail-open", () => {
  const t = setup();
  try {
    const dir = join(t.home, "lone");
    mkdirSync(dir);
    const lone = join(dir, "claude-wrap");
    copyFileSync(wrap, lone);
    const go = (extra) => spawnSync("bash", [lone, "a"], { cwd: t.home, encoding: "utf8", input: "{}", env: cleanEnv(t.home, extra) });
    const r = go({});
    assert.equal(r.status, 70);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /is-business-dir\.sh missing/);
    assert.equal(go({ CLAUDE_WRAP_HOOK: "1" }).status, 0);
  } finally { t.done(); }
});

test("is_business_dir knows ~/projects/dogchef, not the old ~/Projects/dogchef", () => {
  const t = setup();
  try {
    const check = (dir) => spawnSync("bash", ["-c", `. "$1" && is_business_dir "$2"`, "_", join(dirname(wrap), "is-business-dir.sh"), dir], { env: cleanEnv(t.home) }).status;
    mkdirSync(join(t.home, "Projects/dogchef/x"), { recursive: true });
    mkdirSync(join(t.home, "projects/dogchef/x"), { recursive: true });
    assert.equal(check(join(t.home, "projects/dogchef/x")), 0);
    assert.equal(check(join(t.home, "Projects/dogchef/x")), 1);
  } finally { t.done(); }
});

const checkDir = (t, dir) => spawnSync("bash", ["-c", `. "$1" && is_business_dir "$2"`, "_", join(dirname(wrap), "is-business-dir.sh"), dir], { env: cleanEnv(t.home) }).status;

test("before the rename, with only ~/Projects, its dogchef folders are business", () => {
  const t = setup();
  try {
    rmSync(join(t.home, "projects"), { recursive: true });
    mkdirSync(join(t.home, "Projects/dogchef/x"), { recursive: true });
    assert.equal(checkDir(t, join(t.home, "Projects/dogchef/x")), 0);
  } finally { t.done(); }
});

test("a PROJECTS_DIR set by the caller wins over the fallback", () => {
  const t = setup();
  try {
    rmSync(join(t.home, "projects"), { recursive: true });
    mkdirSync(join(t.home, "Projects/dogchef/x"), { recursive: true });
    mkdirSync(join(t.home, "elsewhere/dogchef/x"), { recursive: true });
    const check = (dir) => spawnSync("bash", ["-c", `. "$1" && is_business_dir "$2"`, "_", join(dirname(wrap), "is-business-dir.sh"), dir], { env: cleanEnv(t.home, { PROJECTS_DIR: join(t.home, "elsewhere") }) }).status;
    assert.equal(check(join(t.home, "elsewhere/dogchef/x")), 0);
    assert.equal(check(join(t.home, "Projects/dogchef/x")), 1);
  } finally { t.done(); }
});

test("through the compat symlink ~/Projects -> projects a dogchef folder still counts", () => {
  const t = setup();
  try {
    mkdirSync(join(t.home, "projects/dogchef/x"), { recursive: true });
    symlinkSync("projects", join(t.home, "Projects"));
    assert.equal(checkDir(t, join(t.home, "Projects/dogchef/x")), 0);
    assert.equal(checkDir(t, join(t.home, "Projects")), 1);
  } finally { t.done(); }
});
