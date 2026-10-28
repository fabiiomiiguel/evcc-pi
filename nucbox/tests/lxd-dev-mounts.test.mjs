// lxd-dev-mounts.sh against a stub lxc that keeps device state in files: `dev` gets one disk per dogchef folder
// (~/projects/dogchef, Orca workspaces whose worktrees are dogchef), the old whole-tree disks and stale m-* go,
// a second run changes nothing, and it never names `personal`.
// Run: node --test nucbox/tests/lxd-dev-mounts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../lxd-dev-mounts.sh", import.meta.url));

const STUB = `#!/usr/bin/env bash
s=$STUB_STATE; echo "$*" >> "$s/calls"
case "$1 $2" in
  "config device") case $3 in
    list) ls "$s" | sed -n 's/^dev-//p'; exit 0 ;;
    add) touch "$s/dev-$5"; exit 0 ;;
    remove) rm -f "$s/dev-$5"; exit 0 ;; esac ;;
  "list "*) [[ -e $s/running ]] && echo RUNNING; exit 0 ;;
esac
exit 0
`;

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ldm-"));
  const state = join(home, "state");
  mkdirSync(join(home, "bin"));
  mkdirSync(state);
  for (const d of ["projects/dogchef", "projects/personal", "orca/workspaces/dev/SUP-1", "orca/workspaces/mine/x", "orca/workspaces/empty"]) mkdirSync(join(home, d), { recursive: true });
  const git = (...a) => spawnSync("git", ["-C", join(home, "orca/workspaces/dev/SUP-1"), ...a]);
  git("init", "-q"); git("remote", "add", "origin", "ssh://git@github.com/dogchef-be/dev.git");
  writeFileSync(join(home, "bin/lxc"), STUB, { mode: 0o755 });
  const env = { ...process.env, HOME: home, STUB_STATE: state, PATH: `${join(home, "bin")}:${process.env.PATH}` };
  delete env.PROJECTS_DIR;
  const run = () => spawnSync("bash", [script], { encoding: "utf8", env });
  const calls = () => (existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8").trim().split("\n") : []);
  const devices = () => spawnSync("ls", [state], { encoding: "utf8" }).stdout.split("\n").filter((f) => f.startsWith("dev-")).map((f) => f.slice(4));
  return { home, state, run, calls, devices, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("dev gets only dogchef disks; old whole-tree and stale disks go; a re-run changes nothing", () => {
  const t = setup();
  try {
    for (const d of ["projects", "orca", "m-p-gone", "eth0"]) writeFileSync(join(t.state, `dev-${d}`), "");
    writeFileSync(join(t.state, "running"), "");
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(t.devices().sort(), ["eth0", "m-o-dev", "m-p-dogchef"]);
    const c = t.calls();
    assert.ok(c.includes(`config device add dev m-p-dogchef disk source=${t.home}/projects/dogchef path=${t.home}/projects/dogchef shift=true`));
    assert.ok(c.includes(`config device add dev m-o-dev disk source=${t.home}/orca/workspaces/dev path=${t.home}/orca/workspaces/dev shift=true`));
    for (const d of ["projects", "orca", "m-p-gone"]) assert.ok(c.includes(`config device remove dev ${d}`), d);
    assert.ok(c.every((l) => !/personal/.test(l)), "named personal");
    assert.ok(c.includes(`exec dev -- install -d -o fabio -g fabio -m 755 ${t.home}/projects ${t.home}/orca ${t.home}/orca/workspaces`), "mount parents stay root-only");

    rmSync(join(t.state, "calls"));
    assert.equal(t.run().status, 0);
    assert.deepEqual(t.calls().filter((l) => /config device (add|remove)/.test(l)), []);
  } finally { t.done(); }
});

test("a stopped dev gets its disks and no exec; the parents are left to the caller", () => {
  const t = setup();
  try {
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(t.devices().sort(), ["m-o-dev", "m-p-dogchef"]);
    assert.ok(t.calls().every((l) => !l.startsWith("exec ")));
    assert.match(r.stdout, /install -d/);
  } finally { t.done(); }
});

test("a missing projects dir stops the run before any device change", () => {
  const t = setup();
  try {
    rmSync(join(t.home, "projects"), { recursive: true });
    const r = t.run();
    assert.notEqual(r.status, 0);
    assert.ok(t.calls().every((l) => !/config device (add|remove)/.test(l)));
  } finally { t.done(); }
});
