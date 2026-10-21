// Runs Caddy (as the current user, plain HTTP on a high port) with what `caddy-previews.sh --print` renders, and
// checks the source rule, the port rules and the proxying. Needs the box's caddy.
// Run: node --test nucbox/tests/previews.test.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 18480;
const UP = 4321; // an allowed preview port the test listens on
const UP6 = 4322; // another, listened on [::1] only
const D = "dev.example.com";
const script = fileURLToPath(new URL("../caddy-previews.sh", import.meta.url));
// requests from 127.0.0.1 stand for the tailnet, from [::1] for the LAN
const env = {
  ...process.env, CADDY_DOMAIN: "example.com", PREVIEW_DOMAIN: D, TAILNET_CIDR: "127.0.0.0/8", LAN_CIDR: "::1/128",
  CLOUDFLARE_API_TOKEN: "x".repeat(40),
};
const dir = mkdtempSync(join(tmpdir(), "previews-"));
let caddy, upstream, upstream6;

// The rendered config, moved to plain HTTP on PORT: nothing else changes.
function config() {
  return execFileSync("bash", [script, "--print"], { encoding: "utf8", env })
    .replace("{\n", `{\n\tadmin off\n\tauto_https off\n\thttp_port ${PORT}\n`)
    .replace(/^(\*\.[^ ]+) \{/gm, `http://$1:${PORT} {`);
}

function req(host, path = "/", { from = "127.0.0.1", headers = {} } = {}) {
  return new Promise((ok, ko) => {
    const r = http.request({ host: from, port: PORT, path, headers: { Host: `${host}:${PORT}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, location: res.headers.location ?? "", body: data }));
    });
    r.on("error", ko);
    r.end();
  });
}

before(async () => {
  upstream = http.createServer((q, s) => s.end(`host=${q.headers.host} forwarded=${q.headers["x-forwarded-host"]}`));
  upstream.on("upgrade", (q, sock) => sock.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Host: ${q.headers.host}\r\n\r\n`));
  await new Promise((ok) => upstream.listen(UP, "127.0.0.1", ok));
  upstream6 = http.createServer((q, s) => s.end("ipv6"));
  await new Promise((ok) => upstream6.listen(UP6, "::1", ok));
  writeFileSync(join(dir, "Caddyfile"), config());
  caddy = spawn("caddy", ["run", "--config", join(dir, "Caddyfile")], { env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await req(`${UP}.${D}`).then(() => true, () => false)) return;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error("caddy did not start");
});
after(() => {
  caddy?.kill();
  upstream?.close();
  upstream6?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("rendering again over its own output changes nothing but keeps the rest of the file", () => {
  const print = (file) => execFileSync("bash", [script, "--print", ...(file ? [file] : [])], { encoding: "utf8", env });
  const once = print();
  const other = "other.example.com {\n\trespond 200\n}\n";
  const input = join(dir, "again");
  writeFileSync(input, once.replace("respond @outsiders 403", "respond @outsiders 418") + other);
  assert.equal(print(input), once + other);
});

test("no login anywhere: the render has no security block and needs no login key", () => {
  const out = execFileSync("bash", [script, "--print"], { encoding: "utf8", env });
  assert.doesNotMatch(out, /security|authorize|authenticate|AUTHP_/);
});

test("refused hosts get 404", async () => {
  for (const label of ["3000", "6768", "8080", "9090", "2999", "10000", "abc", "04321", "x4321"]) {
    assert.equal((await req(`${label}.${D}`)).status, 404, label);
  }
});

test("only the tailnet gets in: the LAN gets 403, on every port", async () => {
  for (const label of [UP, UP6, 9090, "abc"]) {
    assert.equal((await req(`${label}.${D}`, "/", { from: "::1" })).status, 403, String(label));
  }
});

test("an allowed port proxies straight away; the dev server sees Host localhost:<port>; [::1] and websockets work", async () => {
  const page = await req(`${UP}.${D}`, "/x?y=1");
  assert.equal(page.status, 200);
  assert.equal(page.body, `host=localhost:${UP} forwarded=${UP}.${D}:${PORT}`);
  assert.equal((await req(`${UP6}.${D}`)).body, "ipv6", "a server on [::1] only is reached too");
  assert.equal((await req(`5555.${D}`)).status, 502); // proxied; nothing listens there

  const ws = await new Promise((ok, ko) => {
    http.request({ host: "127.0.0.1", port: PORT, headers: { Host: `${UP}.${D}:${PORT}`, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } })
      .on("upgrade", (res, sock) => { sock.destroy(); ok(res); }).on("response", (res) => ok(res)).on("error", ko).end();
  });
  assert.equal(ws.statusCode, 101);
  assert.equal(ws.headers["x-host"], `localhost:${UP}`);
});
