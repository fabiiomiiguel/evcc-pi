// The claude wrapper picks CLAUDE_CONFIG_DIR by where it runs, then execs ~/.local/bin/claude (a stub printing it).
// Run: node --test nucbox/tests/claude-wrap.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const wrap = fileURLToPath(new URL("../claude-wrap", import.meta.url));

function setup() {
  const home = mkdtempSync(join(tmpdir(), "cw-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const real = join(home, ".local", "bin", "claude");
  writeFileSync(real, '#!/usr/bin/env bash\necho "real:${CLAUDE_CONFIG_DIR-unset}:$*"\n');
  chmodSync(real, 0o755);
  mkdirSync(join(home, "Projects", "dogchef"), { recursive: true });
  const repo = (name, origin) => {
    const d = join(home, name);
    mkdirSync(d);
    execFileSync("git", ["-C", d, "init", "-q"]);
    execFileSync("git", ["-C", d, "remote", "add", "origin", origin]);
    return d;
  };
  const run = (cwd, extra = {}, args = ["a"]) => {
    const env = { ...process.env, HOME: home, ...extra };
    if (!("CLAUDE_CONFIG_DIR" in extra)) delete env.CLAUDE_CONFIG_DIR;
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
    assert.equal(t.run(join(t.home, "Projects", "dogchef")), `real:${t.home}/.claude-business:a`);
  } finally { t.done(); }
});

test("another origin leaves it unset", () => {
  const t = setup();
  try {
    assert.equal(t.run(t.repo("p", "git@github.com:me/x.git")), "real:unset:a");
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
    const go = (extra) => spawnSync("bash", [lone, "a"], { cwd: t.home, encoding: "utf8", input: "{}", env: { ...process.env, HOME: t.home, ...extra } });
    const r = go({});
    assert.equal(r.status, 70);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /is-business-dir\.sh missing/);
    assert.equal(go({ CLAUDE_WRAP_HOOK: "1" }).status, 0);
  } finally { t.done(); }
});
