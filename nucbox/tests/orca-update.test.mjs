// orca-update.sh against a fake release list (file:// URLs), fake tarballs and a stub systemctl, over a temp HOME: picks the newest
// release that is old enough, rejects a bad checksum, installs and flips `current`/`previous`, rolls back when the unit does not
// come up (unless the old build cannot attach a live daemon's protocol), prunes but keeps a dir a running process uses.
// Run: node --test nucbox/tests/orca-update.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../orca-update.sh", import.meta.url));
const DAY = 86400e3;

const SYSTEMCTL = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$*" in *is-active*) [ "$(readlink "$ORCA_OPT/current")" = "$STUB_BAD" ] && exit 3 ;; esac
exit 0
`;

const sh = (cmd, cwd) => assert.equal(spawnSync("sh", ["-c", cmd], { cwd }).status, 0, cmd);

// The pid record the daemon writes (daemon-entry.js: JSON.stringify of {pid, startedAtMs, linuxStartTicks, bootId} + entryPath,
// appVersion, spawnerExecPath, cgroupUnit, processCeiling, launchNonce, mode 0600), field for field like a live ~/.config/orca/daemon/daemon-v55.pid.
const daemonRecord = (pid) =>
  JSON.stringify({
    pid,
    startedAtMs: 1794267750436.5247,
    linuxStartTicks: "37544539",
    bootId: "484a1372-6eb4-40cf-97b6-f1d16d455af6",
    entryPath: "/home/u/.config/orca/orcad-artifacts/linux-x64-glibc/0.1.0+2c6f5f78208b/daemon-entry.js",
    appVersion: "0.1.0+2c6f5f78208b",
    spawnerExecPath: "/home/u/.config/orca/orcad-artifacts/linux-x64-glibc/runtimes/node/bin/node",
    cgroupUnit: "orca-daemon-bbcc6681-19bf-4201-97ad-f162e1938bc3.scope",
    processCeiling: { state: "off", reason: "disabled" },
    launchNonce: "bbcc6681-19bf-4201-97ad-f162e1938bc3",
  });

// protocols: [own, previous[]] written the way the real bundle exports them (minified names)
function build(dir, version, [own, previous]) {
  mkdirSync(join(dir, "src/bin"), { recursive: true });
  mkdirSync(join(dir, "src/orcad"), { recursive: true });
  writeFileSync(join(dir, "src/bin/orca-ide"), `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "src/VERSION"), `orca ${version}\n`);
  writeFileSync(
    join(dir, "src/orcad/orcad-server.js"),
    `X({GET_SIZE_PROTOCOL_VERSION:()=>PBt,PROTOCOL_VERSION:()=>wi,PREVIOUS_DAEMON_PROTOCOL_VERSIONS:()=>_Ne});var wi,PBt,_Ne,el=g(()=>{wi=${own},PBt=18,_Ne=[${previous.join(",")}]})\n`,
  );
  const out = join(dir, `orca-server-${version}-linux-x64.tar.gz`);
  sh(`mv src orca-server-${version}-linux-x64 && tar -czf ${out} orca-server-${version}-linux-x64 && rm -r orca-server-${version}-linux-x64`, dir);
  return { file: out, sha: createHash("sha256").update(readFileSync(out)).digest("hex") };
}

// releases: [{ tag, ageDays, protocols?, prerelease?, noAsset?, badSha? }]
function setup(releases) {
  const home = mkdtempSync(join(tmpdir(), "ou-"));
  const rel = join(home, "rel");
  mkdirSync(rel);
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin/systemctl"), SYSTEMCTL, { mode: 0o755 });
  const list = releases.map((r, i) => {
    const v = r.tag.replace(/^v/, "");
    const dir = join(rel, String(i));
    mkdirSync(dir);
    const t = /^v\d/.test(r.tag) ? build(dir, v, r.protocols ?? [56, [1, 2, 3]]) : { file: join(dir, "x"), sha: "" };
    const sums = join(dir, "sums.txt");
    writeFileSync(sums, `${r.badSha ? "0".repeat(64) : t.sha}  orca-server-linux-x64.tar.gz\n`);
    return {
      tag_name: r.tag,
      draft: false,
      prerelease: !!r.prerelease,
      published_at: new Date(Date.now() - r.ageDays * DAY).toISOString().replace(/\.\d+Z$/, "Z"),
      assets: r.noAsset ? [] : [
        { name: "orca-server-linux-x64.tar.gz", browser_download_url: `file://${t.file}` },
        { name: "orca-server-sha256sums.txt", browser_download_url: `file://${sums}` },
      ],
    };
  });
  writeFileSync(join(rel, "releases.json"), JSON.stringify(list));
  const opt = join(home, "opt");
  const env = {
    ...process.env, HOME: home, ORCA_OPT: opt, ORCA_PORT: "0", ORCA_UPDATE_API: `file://${join(rel, "releases.json")}`,
    ORCA_UPDATE_HEALTH_TIMEOUT: "2", ORCA_USER_DATA_PATH: join(home, "data"), STUB_LOG: join(home, "systemctl.log"),
    STUB_BAD: "", PATH: `${join(home, "bin")}:${process.env.PATH}`,
  };
  const run = (...args) => spawnSync("bash", [script, ...args], { encoding: "utf8", env });
  const current = () => (existsSync(join(opt, "current")) ? readlinkSync(join(opt, "current")) : null);
  const previous = () => (existsSync(join(opt, "previous")) ? readlinkSync(join(opt, "previous")) : null);
  const calls = () => (existsSync(env.STUB_LOG) ? readFileSync(env.STUB_LOG, "utf8").trim().split("\n") : []);
  const has = (v) => existsSync(join(opt, v, "bin/orca-ide"));
  return { home, opt, env, run, current, previous, calls, has };
}

// the health check connects to ORCA_PORT; a listener stands in for the Orca server
async function listener(env) {
  const srv = createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  env.ORCA_PORT = String(srv.address().port);
  return srv;
}

// a running process whose command line is under `path` (the terminal daemon of an old build)
function fakeProcess(path) {
  const p = spawn("sleep", ["60"], { argv0: join(path, "runtimes/node/bin/node"), stdio: "ignore" });
  return p;
}

test("update picks the newest release older than the delay, skipping prereleases, other tags and releases without the asset", async () => {
  const t = setup([
    { tag: "v1.4.259", ageDays: 1 },
    { tag: "v1.4.258", ageDays: 4 },
    { tag: "v1.4.257", ageDays: 5 },
    { tag: "v1.4.260", ageDays: 9, prerelease: true },
    { tag: "v1.4.261", ageDays: 9, noAsset: true },
    { tag: "android-v0.0.65", ageDays: 9 },
  ]);
  const srv = await listener(t.env);
  try {
    const r = t.run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(t.current(), "1.4.258");
    assert.deepEqual(t.calls(), ["--user restart orca.service", "--user is-active --quiet orca.service"]);
    assert.match(readFileSync(join(t.opt, "1.4.258/VERSION"), "utf8"), /orca 1.4.258/);
    assert.equal(existsSync(join(t.opt, "1.4.258.tmp")), false);
  } finally { srv.close(); rmSync(t.home, { recursive: true }); }
});

test("nothing happens when current is already the newest eligible release, or newer", async () => {
  const t = setup([{ tag: "v1.4.258", ageDays: 4 }]);
  mkdirSync(join(t.opt, "1.4.259"), { recursive: true });
  sh(`ln -s 1.4.259 ${t.opt}/current`);
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\.4\.259 is current/);
  assert.equal(t.current(), "1.4.259");
  assert.deepEqual(t.calls(), []);
  rmSync(t.home, { recursive: true });
});

test("a checksum mismatch installs nothing and exits non-zero", () => {
  const t = setup([{ tag: "v1.4.258", ageDays: 4, badSha: true }]);
  const r = t.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /sha256 mismatch for 1\.4\.258/);
  assert.equal(t.current(), null);
  assert.equal(t.has("1.4.258"), false);
  assert.equal(existsSync(join(t.opt, "1.4.258.tmp")), false);
  assert.deepEqual(t.calls(), []);
  rmSync(t.home, { recursive: true });
});

test("--install takes the newest release with no delay, does not restart, and is a no-op when current exists", () => {
  const t = setup([{ tag: "v1.4.259", ageDays: 0 }, { tag: "v1.4.258", ageDays: 4 }]);
  let r = t.run("--install");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.current(), "1.4.259");
  assert.deepEqual(t.calls(), []);
  r = t.run("--install");
  assert.match(r.stdout, /already installed: 1\.4\.259/);
  rmSync(t.home, { recursive: true });
});

test("update flips current/previous and prunes older dirs, but keeps one a running process executes from", async () => {
  const t = setup([{ tag: "v1.4.259", ageDays: 4 }]);
  for (const v of ["1.4.250", "1.4.255", "1.4.257"]) mkdirSync(join(t.opt, v, "bin"), { recursive: true });
  sh(`ln -s 1.4.257 ${t.opt}/current`);
  const live = fakeProcess(join(t.opt, "1.4.250"));
  const srv = await listener(t.env);
  try {
    const r = t.run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(t.current(), "1.4.259");
    assert.equal(t.previous(), "1.4.257");
    assert.equal(existsSync(join(t.opt, "1.4.255")), false);
    assert.equal(existsSync(join(t.opt, "1.4.250")), true, "dir of a running process was pruned");
    assert.equal(existsSync(join(t.opt, "1.4.257")), true);
  } finally { live.kill(); srv.close(); rmSync(t.home, { recursive: true }); }
});

test("a build that does not come up is rolled back, recorded as bad, and not picked again", async () => {
  const t = setup([{ tag: "v1.4.259", ageDays: 4 }]);
  t.env.STUB_BAD = "1.4.259";
  mkdirSync(join(t.opt, "1.4.257/bin"), { recursive: true });
  writeFileSync(join(t.opt, "1.4.257/orcad.js"), "");
  sh(`ln -s 1.4.257 ${t.opt}/current`);
  const srv = await listener(t.env);
  try {
    let r = t.run();
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stdout, /did not come up on 1\.4\.259/);
    assert.match(r.stdout, /rolled back to 1\.4\.257/);
    assert.equal(t.current(), "1.4.257");
    assert.equal(t.calls().filter((c) => c === "--user restart orca.service").length, 2);
    assert.equal(existsSync(join(t.opt, "1.4.259")), false, "the failed build should be pruned");
    assert.equal(readFileSync(join(t.opt, "bad-versions"), "utf8").trim(), "1.4.259");
    r = t.run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no release/);
  } finally { srv.close(); rmSync(t.home, { recursive: true }); }
});

test("rollback is refused when the old build cannot attach a live daemon's protocol; the new build stays", async () => {
  const t = setup([{ tag: "v1.4.259", ageDays: 4 }]);
  t.env.STUB_BAD = "1.4.259";
  build(t.home, "1.4.257", [56, [40, 41]]);
  sh(`mkdir -p ${t.opt} && tar -xzf ${t.home}/orca-server-1.4.257-linux-x64.tar.gz -C ${t.opt} && mv ${t.opt}/orca-server-1.4.257-linux-x64 ${t.opt}/1.4.257 && ln -s 1.4.257 ${t.opt}/current`);
  const daemon = spawn("sleep", ["60"], { stdio: "ignore" });
  mkdirSync(join(t.home, "data/daemon"), { recursive: true });
  writeFileSync(join(t.home, "data/daemon/daemon-v30.pid"), daemonRecord(daemon.pid));
  const srv = await listener(t.env);
  try {
    const r = t.run();
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stdout, /refusing to roll back to 1\.4\.257: a live terminal daemon speaks protocol 30/);
    assert.equal(t.current(), "1.4.259");
    assert.equal(t.calls().filter((c) => c === "--user restart orca.service").length, 1);
  } finally { daemon.kill(); srv.close(); rmSync(t.home, { recursive: true }); }
});

test("a pid file in a shape the script cannot read counts as a live daemon: rollback is refused", async () => {
  const t = setup([{ tag: "v1.4.259", ageDays: 4 }]);
  t.env.STUB_BAD = "1.4.259";
  build(t.home, "1.4.257", [56, [40, 41]]);
  sh(`mkdir -p ${t.opt} && tar -xzf ${t.home}/orca-server-1.4.257-linux-x64.tar.gz -C ${t.opt} && mv ${t.opt}/orca-server-1.4.257-linux-x64 ${t.opt}/1.4.257 && ln -s 1.4.257 ${t.opt}/current`);
  mkdirSync(join(t.home, "data/daemon"), { recursive: true });
  writeFileSync(join(t.home, "data/daemon/daemon-v30.pid"), "12345\n");
  const srv = await listener(t.env);
  try {
    const r = t.run();
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stdout, /refusing to roll back to 1\.4\.257: a live terminal daemon speaks protocol 30/);
    assert.equal(t.current(), "1.4.259");
  } finally { srv.close(); rmSync(t.home, { recursive: true }); }
});

test("rollback goes ahead when the old build lists the live daemon's protocol", async () => {
  const t = setup([{ tag: "v1.4.259", ageDays: 4 }]);
  t.env.STUB_BAD = "1.4.259";
  build(t.home, "1.4.257", [56, [30, 41]]);
  sh(`mkdir -p ${t.opt} && tar -xzf ${t.home}/orca-server-1.4.257-linux-x64.tar.gz -C ${t.opt} && mv ${t.opt}/orca-server-1.4.257-linux-x64 ${t.opt}/1.4.257 && ln -s 1.4.257 ${t.opt}/current`);
  const daemon = spawn("sleep", ["60"], { stdio: "ignore" });
  mkdirSync(join(t.home, "data/daemon"), { recursive: true });
  writeFileSync(join(t.home, "data/daemon/daemon-v30.pid"), daemonRecord(daemon.pid));
  const srv = await listener(t.env);
  try {
    const r = t.run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /rolled back to 1\.4\.257/);
    assert.equal(t.current(), "1.4.257");
  } finally { daemon.kill(); srv.close(); rmSync(t.home, { recursive: true }); }
});

test("install-orca.sh installs the tarball, renders the three units with this folder and ORCA_HOST, enables linger, the timer and the service", () => {
  const t = setup([{ tag: "v1.4.259", ageDays: 0 }]);
  for (const cmd of ["sudo", "loginctl"]) writeFileSync(join(t.home, "bin", cmd), '#!/bin/sh\necho "$0 $*" >> "$STUB_LOG"\n', { mode: 0o755 });
  t.env.ORCA_HOST = "orca.example.com";
  t.env.ORCA_PORT = "6768";
  const run = () => spawnSync("bash", [fileURLToPath(new URL("../install-orca.sh", import.meta.url))], { encoding: "utf8", env: t.env });
  for (const pass of [1, 2]) {
    const r = run();
    assert.equal(r.status, 0, `run ${pass}: ${r.stderr}`);
  }
  assert.equal(t.current(), "1.4.259");
  const units = join(t.home, ".config/systemd/user");
  const orca = readFileSync(join(units, "orca.service"), "utf8");
  assert.match(orca, /^ExecStart=%h\/\.local\/opt\/orca\/current\/bin\/orca-ide serve --supervise --port 6768 --pairing-address wss:\/\/orca\.example\.com$/m);
  assert.match(orca, /^KillMode=process$/m);
  assert.match(readFileSync(join(units, "orca-update.service"), "utf8"), new RegExp(`^ExecStart=${fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")}/orca-update\\.sh$`, "m"));
  assert.equal(existsSync(join(units, "orca-update.timer")), true);
  const calls = t.calls();
  assert.ok(calls.some((c) => / enable-linger /.test(c)));
  assert.ok(calls.includes("--user enable --now orca-update.timer"));
  assert.ok(calls.includes("--user enable --now orca.service"));
  assert.ok(!calls.some((c) => /restart/.test(c)), "install must not restart a running orca.service");
  rmSync(t.home, { recursive: true });
});
