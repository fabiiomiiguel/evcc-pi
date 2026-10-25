// The account guard (UserPromptSubmit hook) and its installation in the shared settings.
// Run: node --test nucbox/tests/claude-guard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../claude-business.sh", import.meta.url));

function setup(settings = "{}") {
  const home = mkdtempSync(join(tmpdir(), "cg-"));
  for (const d of [".claude/skills", ".claude/plugins", "Projects/dogchef", "Projects/personal", "wt"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "x");
  writeFileSync(join(home, ".claude/settings.json"), settings);
  execFileSync("git", ["-C", join(home, "wt"), "init", "-q"]);
  execFileSync("git", ["-C", join(home, "wt"), "remote", "add", "origin", "git@github.com:dogchef-be/dev.git"]);
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/claude"), `#!/bin/sh\ntouch "${home}/real-ran"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  const install = () => execFileSync("bash", [script], { encoding: "utf8", env });
  const guard = (cwd, config, stdin = JSON.stringify({ cwd })) => {
    const e = { ...env, CLAUDE_WRAP_GUARD: "1" };
    if (config) e.CLAUDE_CONFIG_DIR = join(home, config);
    return spawnSync("bash", [join(home, ".local/claude-wrap/claude")], { input: stdin, encoding: "utf8", env: e });
  };
  return { home, install, guard, settings: () => JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")), done: () => rmSync(home, { recursive: true, force: true }) };
}

test("account mismatch blocks, a match passes silently", () => {
  const t = setup();
  try {
    t.install();
    const dog = join(t.home, "Projects/dogchef/dev");
    mkdirSync(dog);
    const cases = [[dog, undefined, 2], [dog, ".claude-business", 0], [join(t.home, "Projects/personal"), ".claude-business", 2],
      [join(t.home, "Projects/personal"), undefined, 0], [join(t.home, "Projects/personal"), ".claude", 0], [join(t.home, "wt"), undefined, 2], [join(t.home, "wt"), ".claude-business", 0]];
    for (const [cwd, cfg, code] of cases) {
      const r = t.guard(cwd, cfg);
      assert.equal(r.status, code, `${cwd} ${cfg}`);
      if (code === 2) assert.match(r.stderr, /Wrong Claude account.*(personal|business)/);
      else assert.equal(r.stderr, "");
    }
  } finally { t.done(); }
});

test("GUARD=0 starts claude on the personal account and its guard lets prompts through", () => {
  const t = setup();
  try {
    t.install();
    const dog = join(t.home, "Projects/dogchef");
    const run = (extra) => spawnSync("bash", [join(t.home, ".local/claude-wrap/claude")], { cwd: dog, input: JSON.stringify({ cwd: dog }), encoding: "utf8", env: { ...process.env, HOME: t.home, ...extra } });
    assert.equal(run({ CLAUDE_WRAP_GUARD: "0" }).status, 0);
    assert.ok(existsSync(join(t.home, "real-ran")), "GUARD=0 starts the real claude");
    assert.equal(run({ CLAUDE_WRAP_GUARD: "1", CLAUDE_WRAP_BYPASS: "1" }).status, 0);
  } finally { t.done(); }
});

test("garbage stdin, missing cwd and an unknown config dir fail open", () => {
  const t = setup();
  try {
    t.install();
    assert.equal(t.guard("/", undefined, "not json").status, 0);
    assert.equal(t.guard("/", undefined, "{}").status, 0);
    assert.equal(t.guard("/nope/x", undefined).status, 0);
    assert.equal(t.guard(join(t.home, "Projects/dogchef"), "elsewhere").status, 0);
    assert.ok(!existsSync(join(t.home, "real-ran")), "guard mode never starts the real claude");
  } finally { t.done(); }
});

test("settings merge keeps other keys and hooks, backs up once, second run identical", () => {
  const mine = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "s" }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine" }] }] } };
  const t = setup(JSON.stringify(mine));
  try {
    t.install();
    const s = t.settings();
    const guard = `CLAUDE_WRAP_GUARD=1 ${join(t.home, ".local/claude-wrap/claude")}`;
    assert.equal(s.model, "opus");
    assert.deepEqual(s.hooks.Stop, mine.hooks.Stop);
    assert.deepEqual(s.hooks.UserPromptSubmit[0], mine.hooks.UserPromptSubmit[0]);
    assert.equal(s.hooks.UserPromptSubmit.filter((g) => g.hooks[0].command === guard).length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(t.home, ".claude/settings.json.bak-claude-business"), "utf8")), mine);
    const before = readFileSync(join(t.home, ".claude/settings.json"), "utf8");
    t.install();
    assert.equal(readFileSync(join(t.home, ".claude/settings.json"), "utf8"), before);
  } finally { t.done(); }
});

test("an empty settings object gets the hook; the business dir keeps only the symlink", () => {
  const t = setup();
  try {
    t.install();
    assert.equal(t.settings().hooks.UserPromptSubmit.length, 1);
    assert.ok(existsSync(join(t.home, ".claude-business/settings.json")));
  } finally { t.done(); }
});
