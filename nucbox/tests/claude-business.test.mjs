// Runs claude-business-direnv.sh twice against a temp HOME with stub direnv/sudo: the first run sets everything up,
// the second changes nothing, existing files are kept. Run: node --test nucbox/tests/claude-business.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../claude-business-direnv.sh", import.meta.url));
const wrapSrc = fileURLToPath(new URL("../claude-wrap", import.meta.url));
const LINK = 'export CLAUDE_CONFIG_DIR="$HOME/.claude-business"';

function setup() {
  const home = mkdtempSync(join(tmpdir(), "cb-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("direnv", `[[ $1 == allow ]] && echo "allow $2" >> "${home}/direnv.log"; exit 0`);
  stub("sudo", `echo "sudo $*" >> "${home}/sudo.log"`);
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".claude", "plugins"));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "x");
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  mkdirSync(join(home, "Projects", "dogchef"), { recursive: true });
  const run = () => execFileSync("bash", [script], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
  const read = (p) => readFileSync(join(home, p), "utf8");
  return { home, run, read, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("first run sets up, second run changes nothing", () => {
  const t = setup();
  try {
    t.run();
    assert.equal(readlinkSync(join(t.home, ".claude-business", "skills")), join(t.home, ".claude", "skills"));
    for (const n of ["CLAUDE.md", "settings.json", "skills", "plugins"]) assert.ok(lstatSync(join(t.home, ".claude-business", n)).isSymbolicLink());
    assert.equal(t.read("Projects/dogchef/.envrc"), `${LINK}\n`);
    assert.equal(t.read(".bashrc").match(/direnv hook bash/g).length, 1);
    assert.equal(t.read(".bashrc").match(/claude-wrap/g).length, 1);
    assert.equal(t.read(".local/claude-wrap/claude"), readFileSync(wrapSrc, "utf8"));
    assert.ok(statSync(join(t.home, ".local/claude-wrap/claude")).mode & 0o100);
    const before = [".bashrc", "Projects/dogchef/.envrc"].map(t.read);
    const out = t.run();
    assert.deepEqual([".bashrc", "Projects/dogchef/.envrc"].map(t.read), before);
    assert.match(out, /already/);
    assert.ok(!existsSync(join(t.home, "sudo.log")));
  } finally { t.done(); }
});

test("an .envrc with another line keeps it and gets the export once", () => {
  const t = setup();
  try {
    writeFileSync(join(t.home, "Projects/dogchef/.envrc"), "export FOO=1");
    t.run(); t.run();
    assert.equal(t.read("Projects/dogchef/.envrc"), `export FOO=1\n${LINK}\n`);
  } finally { t.done(); }
});

test("a real settings.json in ~/.claude-business is not replaced", () => {
  const t = setup();
  try {
    mkdirSync(join(t.home, ".claude-business"));
    writeFileSync(join(t.home, ".claude-business", "settings.json"), "mine");
    const out = t.run();
    assert.equal(t.read(".claude-business/settings.json"), "mine");
    assert.match(out, /settings\.json.*left alone/);
  } finally { t.done(); }
});
