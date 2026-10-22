// Runs pihole-dev-dns.sh against stubs of sudo, pihole-FTL, ip, dig and systemctl: checks the Pi-hole line it
// writes and that the other lines stay. Run: node --test nucbox/tests/pihole-dns.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../pihole-dev-dns.sh", import.meta.url));

function run(lines) {
  const dir = mkdtempSync(join(tmpdir(), "pihole-"));
  const stub = (name, body) => { writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  writeFileSync(join(dir, "toml"), `[misc]\ndnsmasq_lines = ${JSON.stringify(lines)}\n`);
  stub("sudo", `[[ $1 == -v ]] && exit 0; [[ $1 == cat ]] && exec cat "${dir}/toml"; exec "$@"`);
  stub("pihole-FTL", `printf '%s' "$3" > "${dir}/set"`);
  stub("ip", `echo "1.1.1.1 via 192.168.68.1 dev br0 src 192.168.68.50 uid 1000 \\    cache "`);
  stub("dig", `echo 192.168.68.50`);
  stub("systemctl", "exit 0");
  try {
    execFileSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PREVIEW_DOMAIN: "dev.example.com" } });
    try { return JSON.parse(readFileSync(join(dir, "set"), "utf8")); } catch { return null; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("adds the preview domain with the box's LAN address and keeps the other lines", () => {
  assert.deepEqual(run(["address=/test/10.0.0.5", "address=/casa.example.com/192.168.68.50"]),
    ["address=/test/10.0.0.5", "address=/casa.example.com/192.168.68.50", "address=/dev.example.com/192.168.68.50"]);
});

test("replaces an older line for the same domain only", () => {
  assert.deepEqual(run(["address=/dev.example.com/100.1.1.1", "address=/x.dev.example.com/1.2.3.4"]),
    ["address=/x.dev.example.com/1.2.3.4", "address=/dev.example.com/192.168.68.50"]);
});

test("writes nothing when the line is already there", () => {
  assert.equal(run(["address=/dev.example.com/192.168.68.50"]), null);
});
