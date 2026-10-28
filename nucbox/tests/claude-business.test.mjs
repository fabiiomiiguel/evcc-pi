// Runs claude-business.sh twice against a temp HOME: the first run sets everything up, the second changes nothing,
// existing files are kept and the old direnv setup is cleaned. Run: node --test nucbox/tests/claude-business.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../claude-business.sh", import.meta.url));
const wrapSrc = fileURLToPath(new URL("../claude-wrap", import.meta.url));
const LINK = 'export CLAUDE_CONFIG_DIR="$HOME/.claude-business"';

function setup() {
  const home = mkdtempSync(join(tmpdir(), "cb-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("sudo", `echo "sudo $*" >> "${home}/sudo.log"`);
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".claude", "plugins"));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "x");
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  mkdirSync(join(home, "projects", "dogchef"), { recursive: true });
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
    assert.ok(!existsSync(join(t.home, "projects/dogchef/.envrc")));
    assert.ok(!t.read(".bashrc").includes("direnv"));
    assert.equal(t.read(".bashrc").match(/claude-wrap/g).length, 1);
    assert.equal(t.read(".local/claude-wrap/claude"), readFileSync(wrapSrc, "utf8"));
    assert.equal(t.read(".local/claude-wrap/is-business-dir.sh"), readFileSync(new URL("../is-business-dir.sh", import.meta.url), "utf8"));
    assert.ok(statSync(join(t.home, ".local/claude-wrap/claude")).mode & 0o100);
    const before = [t.read(".bashrc")];
    const out = t.run();
    assert.deepEqual([t.read(".bashrc")], before);
    assert.match(out, /already/);
    assert.ok(!existsSync(join(t.home, "sudo.log")));
  } finally { t.done(); }
});

const HOOK = 'eval "$(direnv hook bash)"';
const oldLayout = (t, envrc) => {
  writeFileSync(join(t.home, ".bashrc"), `alias a=b\n${HOOK}\n`);
  writeFileSync(join(t.home, "projects/dogchef/.envrc"), envrc);
};

test("old layout: hook and a lone export line are removed, the .envrc deleted, second run identical", () => {
  const t = setup();
  try {
    oldLayout(t, `${LINK}\n`);
    t.run();
    assert.ok(!t.read(".bashrc").includes("direnv"));
    assert.ok(t.read(".bashrc").includes("alias a=b"));
    assert.ok(!existsSync(join(t.home, "projects/dogchef/.envrc")));
    const before = t.read(".bashrc");
    t.run();
    assert.equal(t.read(".bashrc"), before);
  } finally { t.done(); }
});

test("old layout: an .envrc with another line keeps it without the export", () => {
  const t = setup();
  try {
    oldLayout(t, `export FOO=1\n${LINK}\n`);
    t.run(); t.run();
    assert.equal(t.read("projects/dogchef/.envrc"), "export FOO=1\n");
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

// Ubuntu's default shapes: .bashrc returns early when non-interactive, .profile sources it then prepends ~/.local/bin.
test("claude resolves to the wrapper in login, interactive login and interactive bash; second run identical", () => {
  const t = setup();
  try {
    writeFileSync(join(t.home, ".bashrc"), "case $- in\n    *i*) ;;\n      *) return;;\nesac\nalias a=b\n");
    writeFileSync(join(t.home, ".profile"), [
      'if [ -n "$BASH_VERSION" ]; then',
      '    if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
      "fi",
      'if [ -d "$HOME/.local/bin" ] ; then PATH="$HOME/.local/bin:$PATH"; fi', ""].join("\n"));
    mkdirSync(join(t.home, ".local/bin"), { recursive: true });
    writeFileSync(join(t.home, ".local/bin/claude"), "#!/bin/sh\n");
    chmodSync(join(t.home, ".local/bin/claude"), 0o755);
    t.run();
    const want = join(t.home, ".local/claude-wrap/claude");
    for (const flags of ["-lc", "-ilc", "-ic"]) {
      const out = execFileSync("bash", [flags, "command -v claude"], { encoding: "utf8", env: { HOME: t.home, PATH: "/usr/bin:/bin" } });
      assert.equal(out.trim(), want, flags);
    }
    const before = [t.read(".profile"), t.read(".bashrc")];
    t.run();
    assert.deepEqual([t.read(".profile"), t.read(".bashrc")], before);
  } finally { t.done(); }
});
