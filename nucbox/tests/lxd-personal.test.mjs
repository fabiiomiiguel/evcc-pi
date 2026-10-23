// lxd-personal.sh against a stub lxc that keeps its state in files and logs every call: the first run creates the
// bridge, the container, the user, the disks, the proxies and the tools; a second run changes nothing; a host that
// drops the container's egress stops the run before the user, disks and packages. Never touches `dev` or br0.
// Run: node --test nucbox/tests/lxd-personal.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../lxd-personal.sh", import.meta.url));

const STUB = `#!/usr/bin/env bash
s=$STUB_STATE; echo "$*" >> "$s/calls"
case "$1 $2" in
  "network show") [[ -e $s/net ]]; exit ;;
  "network create") touch "$s/net"; exit 0 ;;
  "list "*) [[ -e $s/running ]] && echo RUNNING
    # an unanchored pattern also matches personal-old
    [[ -e $s/oldrunning && $2 != ^* ]] && echo RUNNING; exit 0 ;;
  "start "*) touch "$s/running"; exit 0 ;;
  "config device") case $3 in
    list) ls "$s" | sed -n 's/^dev-//p'; exit 0 ;;
    add) touch "$s/dev-$5"; exit 0 ;; esac ;;
esac
[[ $1 == info ]] && { [[ -e $s/inst ]]; exit; }
[[ $1 == init ]] && { touch "$s/inst"; exit 0; }
[[ $1 == exec ]] || exit 0
shift 3; cmd="$*"
case $cmd in
  "id "*) [[ -e $s/user ]]; exit ;;
  *usermod\\ -l*) touch "$s/user" ;;
  *"/dev/tcp/1.1.1.1"*) [[ -e $s/noegress ]] && exit 1; [[ -e $s/nodns && $cmd == *"getent hosts"* ]] && exit 1 ;;
  *"command -v docker"*) [[ -e $s/prov ]]; exit ;;
  *apt-get*) touch "$s/prov" ;;
esac
exit 0
`;

function setup() {
  const home = mkdtempSync(join(tmpdir(), "lp-"));
  const state = join(home, "state");
  mkdirSync(join(home, "bin"));
  mkdirSync(state);
  mkdirSync(join(home, "Projects"));
  mkdirSync(join(home, "orca"));
  writeFileSync(join(home, "bin/lxc"), STUB, { mode: 0o755 });
  const run = () => spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, HOME: home, STUB_STATE: state, PATH: `${join(home, "bin")}:${process.env.PATH}` } });
  const calls = () => readFileSync(join(state, "calls"), "utf8").trim().split("\n");
  const reset = () => rmSync(join(state, "calls"), { force: true });
  return { home, state, run, calls, reset, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("first run creates everything, second run only reads", () => {
  const t = setup();
  try {
    const r1 = t.run();
    assert.equal(r1.status, 0, r1.stderr);
    const c1 = t.calls();
    const has = (re) => c1.some((l) => re.test(l));
    assert.ok(has(/^network create lxdpersonal0 ipv4\.address=10\.250\.50\.1\/24 ipv4\.nat=true .*dns\.mode=none raw\.dnsmasq=port=0$/));
    assert.ok(has(/^init ubuntu:26\.04 personal -n lxdpersonal0 .*limits\.memory=8GiB/));
    assert.ok(has(/^start personal$/));
    assert.ok(has(/usermod -l fabio/));
    for (const d of ["projects", "orca"]) assert.ok(has(new RegExp(`^config device add personal ${d} disk source=${t.home}/.* shift=true$`)), d);
    for (const p of [3010, 5000, 8000, 8010, 8026, 8125, 9001]) assert.ok(has(new RegExp(`^config device add personal p${p} proxy listen=tcp:127\\.0\\.0\\.1:${p} connect=tcp:127\\.0\\.0\\.1:${p}$`)), String(p));
    assert.ok(has(/^config device add personal p3100 proxy listen=tcp:127\.0\.0\.1:3100 connect=tcp:127\.0\.0\.1:3000$/));
    assert.ok(has(/apt-get install -y docker\.io/) && has(/setup_24\.x/));
    assert.ok(c1.every((l) => !/(^| )dev( |$)|br0/.test(l)), "touched dev or br0");

    t.reset();
    const r2 = t.run();
    assert.equal(r2.status, 0, r2.stderr);
    const writes = t.calls().filter((l) => /^(network create|init|start|config device add)\b|usermod|apt-get/.test(l));
    assert.deepEqual(writes, []);
  } finally { t.done(); }
});

test("the container's only resolver is the host's Pi-hole, no public fallback", () => {
  const t = setup();
  try {
    assert.equal(t.run().status, 0);
    const cfg = t.calls().join("\n");
    assert.match(cfg, /nameservers: \{addresses: \[192\.168\.68\.50\]\}/);
    assert.doesNotMatch(cfg, /1\.1\.1\.1\]|9\.9\.9\.9|10\.250\.50\.1\]/);
  } finally { t.done(); }
});

test("a host that drops the container's egress stops before user, disks and packages", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "noegress"), "");
    const r = t.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /sudo ufw status verbose/);
    assert.match(r.stderr, /sudo nft list ruleset/);
    assert.ok(t.calls().every((l) => !/usermod|config device add|apt-get/.test(l)));
    assert.ok(existsSync(join(t.state, "inst")));
  } finally { t.done(); }
});

test("TCP egress without name resolution still stops the run", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "nodns"), "");
    const r = t.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ufw/);
    assert.ok(t.calls().some((l) => /\/dev\/tcp\/1\.1\.1\.1.*getent hosts/.test(l)));
    assert.ok(t.calls().every((l) => !/apt-get/.test(l)));
  } finally { t.done(); }
});

test("a running personal-old does not stand in for a stopped personal", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "oldrunning"), "");
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(t.calls().some((l) => l === "start personal"));
  } finally { t.done(); }
});
