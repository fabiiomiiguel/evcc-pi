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
  "network acl") [[ $3 == show ]] && { [[ -e $s/acl ]]; exit; }; [[ $3 == create ]] && touch "$s/acl"; [[ $3 == edit ]] && cat > "$s/acl-yaml"; exit 0 ;;
  "network get") cat "$s/set-$4" 2>/dev/null; exit 0 ;;
  "network set") echo "\${4#*=}" > "$s/set-\${4%%=*}"; exit 0 ;;
  "list "*) [[ -e $s/running ]] && echo RUNNING
    # an unanchored pattern also matches personal-old
    [[ -e $s/oldrunning && $2 != ^* ]] && echo RUNNING; exit 0 ;;
  "start "*) touch "$s/running"; exit 0 ;;
  "config device") case $3 in
    list) ls "$s" | sed -n 's/^dev-//p'; exit 0 ;;
    add) touch "$s/dev-$5"; exit 0 ;;
    remove) rm -f "$s/dev-$5"; exit 0 ;; esac ;;
esac
[[ $1 == info ]] && { [[ -e $s/inst ]]; exit; }
[[ $1 == init ]] && { touch "$s/inst"; exit 0; }
[[ $1 == exec ]] || exit 0
shift 3; cmd="$*"; args=("$@")
case $cmd in
  "id "*) [[ -e $s/user ]]; exit ;;
  *usermod\\ -l*) touch "$s/user" ;;
  *"/dev/tcp/1.1.1.1"*) [[ -e $s/noegress ]] && exit 1; [[ -e $s/nodns && $cmd == *"getent hosts"* ]] && exit 1 ;;
  "sudo -u fabio"*) [[ -e $s/prov && ! -e $s/stillbroken ]]; exit ;;
  *apt-get*) [[ -e $s/updatefail ]] && { PATH="$s/fakebin:$PATH" "\${args[@]}"; exit; }
    [[ -e $s/aptfail ]] && exit 100; touch "$s/prov" ;;
esac
exit 0
`;

function assertRules(y) {
  assert.match(y, /destination: 192\.168\.68\.0-192\.168\.68\.49,192\.168\.68\.51-192\.168\.71\.255,100\.64\.0\.0\/10/);
  for (const proto of ["tcp", "udp"]) assert.match(y, new RegExp(`protocol: ${proto}\\n\\s+destination: 192\\.168\\.68\\.50\\n\\s+destination_port: 1-52,54-65535`));
  assert.match(y, /protocol: icmp4\n\s+destination: 192\.168\.68\.50/);
  assert.equal((y.match(/action: drop/g) ?? []).length, 4);
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "lp-"));
  const state = join(home, "state");
  mkdirSync(join(home, "bin"));
  mkdirSync(state);
  for (const d of ["Projects/dogchef", "Projects/personal", "orca/workspaces/dev/SUP-1", "orca/workspaces/mine/x", "orca/workspaces/empty"]) mkdirSync(join(home, d), { recursive: true });
  // a workspace is dogchef when a worktree's origin is in dogchef-be/
  const git = (...a) => spawnSync("git", ["-C", join(home, "orca/workspaces/dev/SUP-1"), ...a]);
  git("init", "-q"); git("remote", "add", "origin", "ssh://git@github.com/dogchef-be/dev.git");
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
    for (const d of ["m-p-personal", "m-o-mine", "m-o-empty"]) assert.ok(has(new RegExp(`^config device add personal ${d} disk source=${t.home}/.* path=${t.home}/.* shift=true$`)), d);
    assert.ok(has(new RegExp(`^exec personal -- install -d -o fabio -g fabio -m 755 ${t.home}/Projects ${t.home}/orca ${t.home}/orca/workspaces$`)), "mount parents stay root-only");
    assert.ok(c1.every((l) => !/dogchef|workspaces\/dev|device add personal (projects|orca) /.test(l.replace(t.home, ""))), "mounted dogchef files or a whole tree");
    for (const p of [3010, 5000, 8000, 8010, 8026, 8125, 9001]) assert.ok(has(new RegExp(`^config device add personal p${p} proxy listen=tcp:127\\.0\\.0\\.1:${p} connect=tcp:127\\.0\\.0\\.1:${p}$`)), String(p));
    assert.ok(has(/^config device add personal p3100 proxy listen=tcp:127\.0\.0\.1:3100 connect=tcp:127\.0\.0\.1:3000$/));
    assert.ok(has(/apt-get install -y docker\.io .*php8\.4-cli php8\.4-mbstring .*python3-venv/) && /composer\.github\.io\/installer\.sig.*sha384.*--install-dir=\/usr\/local\/bin/s.test(c1.join("\n")) && has(/setup_24\.x/) && has(/packages\.sury\.org\/php\/apt\.gpg/));
    assert.ok(has(/^network acl create personal-egress$/));
    assert.ok(c1.every((l) => !/^network acl rule/.test(l)));
    assertRules(readFileSync(join(t.state, "acl-yaml"), "utf8"));
    assert.ok(has(/^network set lxdpersonal0 security\.acls=personal-egress$/) && has(/^network set lxdpersonal0 security\.acls\.default\.egress\.action=allow$/));
    assert.ok(c1.every((l) => !/(^| )dev( |$)|br0/.test(l)), "touched dev or br0");

    t.reset();
    const r2 = t.run();
    assert.equal(r2.status, 0, r2.stderr);
    const writes = t.calls().filter((l) => /^(network create|network acl create|network acl rule|network set|init|start|config device add)\b|usermod|apt-get/.test(l));
    assert.deepEqual(writes, []);
    assert.equal(t.calls().filter((l) => l === "network acl edit personal-egress").length, 1, "the ACL rules are re-applied (idempotent) on every run");
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

test("a failing provisioning step stops the run with a non-zero status and no ready line", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "aptfail"), "");
    const r = t.run();
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /ready/);
  } finally { t.done(); }
});

test("tools that are installed but unusable by the user stop the run", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "stillbroken"), "");
    const r = t.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /php 8\.4, composer, docker, node or python3/);
    assert.doesNotMatch(r.stdout, /ready/);
  } finally { t.done(); }
});

test("readiness is checked as the user: php 8.4, composer, docker, node, python3", () => {
  const t = setup();
  try {
    assert.equal(t.run().status, 0);
    const l = t.calls().find((c) => /^exec personal -- sudo -u fabio -H bash -lc /.test(c));
    assert.ok(l, "no readiness call");
    for (const w of ["PHP_VERSION_ID>=80400", "composer -V", "docker ps", "node -v", "python3 -V"]) assert.ok(l.includes(w), w);
  } finally { t.done(); }
});

test("an ACL that exists without rules gets them on the next run (fails closed)", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "acl"), "");
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(t.calls().some((l) => l === "network acl edit personal-egress"));
    assertRules(readFileSync(join(t.state, "acl-yaml"), "utf8"));
  } finally { t.done(); }
});

test("a failing apt-get update stops provisioning before anything else runs", { skip: process.getuid() === 0 }, () => {
  const t = setup();
  try {
    const fb = join(t.state, "fakebin");
    mkdirSync(fb);
    writeFileSync(join(fb, "apt-get"), `#!/usr/bin/env bash\necho "apt-get $*" >> "${t.state}/fake"\n[[ $1 == update ]] && exit 100\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(fb, "curl"), `#!/usr/bin/env bash\necho "curl $*" >> "${t.state}/fake"\n`, { mode: 0o755 });
    writeFileSync(join(t.state, "updatefail"), "");
    const r = t.run();
    assert.notEqual(r.status, 0);
    assert.deepEqual(readFileSync(join(t.state, "fake"), "utf8").trim().split("\n"), ["apt-get update"]);
  } finally { t.done(); }
});

test("a re-run adds a new personal dir, removes stale mounts and the old whole-tree disks, never a dogchef dir", () => {
  const t = setup();
  try {
    for (const d of ["projects", "orca", "m-p-gone"]) writeFileSync(join(t.state, `dev-${d}`), "");
    mkdirSync(join(t.home, "Projects/newrepo"));
    mkdirSync(join(t.home, "orca/workspaces/fresh"));
    assert.equal(t.run().status, 0);
    const c = t.calls();
    for (const d of ["projects", "orca", "m-p-gone"]) assert.ok(c.includes(`config device remove personal ${d}`), d);
    for (const d of ["m-p-newrepo", "m-o-fresh"]) assert.ok(c.some((l) => l.startsWith(`config device add personal ${d} `)), d);
    assert.ok(c.every((l) => !/add personal m-[po]-(dogchef|dev) /.test(l)));
    t.reset();
    assert.equal(t.run().status, 0);
    assert.deepEqual(t.calls().filter((l) => /config device (add|remove)/.test(l)), []);
  } finally { t.done(); }
});
