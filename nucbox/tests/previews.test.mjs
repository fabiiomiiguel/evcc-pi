// Runs Caddy (as the current user, plain HTTP on a high port) with what `caddy-previews.sh --print` renders, and
// checks the port rules, the login and the proxying. Needs the box's caddy (with caddy-security).
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
const D = "preview.example.com";
const script = fileURLToPath(new URL("../caddy-previews.sh", import.meta.url));
const env = {
  ...process.env, CADDY_DOMAIN: "example.com", EVERON_HOST: "everon.example.com", EVERON_USER: "fabio",
  LAN_CIDR: "127.0.0.0/8", CLOUDFLARE_API_TOKEN: "x".repeat(40), AUTHP_SHARED_KEY: "a".repeat(64), AUTHP_PREVIEW_KEY: "b".repeat(64),
};
const dir = mkdtempSync(join(tmpdir(), "previews-"));
let caddy, upstream, upstream6;

// The rendered config, moved to plain HTTP on PORT with a real hash and a writable store: nothing else changes.
function config() {
  const hash = execFileSync("caddy", ["hash-password", "--plaintext", "secret"], { encoding: "utf8" }).trim();
  return execFileSync("bash", [script, "--print"], { encoding: "utf8", env })
    .replace("{\n", `{\n\tadmin off\n\tauto_https off\n\thttp_port ${PORT}\n`)
    .replace(/password "[^"]*"/, `password "bcrypt:${hash.split("$")[2]}:${hash}"`)
    .replace("/var/lib/caddy/authcrunch/users.json", join(dir, "users.json"))
    .replaceAll(`https://login.${D}/`, `http://login.${D}:${PORT}/`)
    .replace(/^(\*\.[^ ]+) \{/gm, `http://$1:${PORT} {`);
}

const jar = {};
function req(host, path = "/", { method = "GET", body, headers = {} } = {}) {
  return new Promise((ok, ko) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    const h = { Host: `${host}:${PORT}`, Cookie: cookie, ...headers };
    if (body) Object.assign(h, { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) });
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: h }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        for (const c of res.headers["set-cookie"] ?? []) {
          const kv = c.split(";")[0];
          jar[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
        }
        ok({ status: res.statusCode, location: res.headers.location ?? "", cookies: res.headers["set-cookie"] ?? [], body: data });
      });
    });
    r.on("error", ko);
    r.end(body);
  });
}
const path = (url) => url.replace(/^https?:\/\/[^/]+/, "");

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

test("refused hosts get 404 before the login", async () => {
  for (const label of ["3000", "6768", "8080", "9090", "2999", "10000", "abc", "04321", "x4321"]) {
    assert.equal((await req(`${label}.${D}`)).status, 404, label);
  }
});

test("an allowed port without a session goes to the login", async () => {
  const r = await req(`${UP}.${D}`, "/x?y=1");
  assert.equal(r.status, 302);
  assert.equal((await req(`${UP6}.${D}`)).status, 302, "the [::1] fallback is behind the login too");
  assert.match(r.location, new RegExp(`^http://login\\.${D}:${PORT}/\\?redirect_url=`));
});

test("one login opens every allowed port; the dev server sees Host localhost:<port>; websockets pass; logout ends it", async () => {
  // the portal only keeps a redirect back to a preview (the browser's URL: https, no port)
  const portal = (url) => req(`login.${D}`, "/?redirect_url=" + encodeURIComponent(url));
  assert.ok(!(await portal("https://everon.example.com/")).cookies.some((c) => c.startsWith("AUTHP_REDIRECT_URL=")));
  const back = `https://${UP}.${D}/x?y=1`;
  assert.ok((await portal(back)).cookies.some((c) => c.startsWith(`AUTHP_REDIRECT_URL=${back};`)));

  const user = await req(`login.${D}`, "/login", { method: "POST", body: "username=fabio&realm=local" });
  // the password step is a form on the sandbox page, with its own id
  const form = (await req(`login.${D}`, path(user.location))).body;
  const action = form.match(/action="([^"]+\/password-auth)"/)[1];
  const id = form.match(/name="sandbox_id"[^>]*value="([^"]+)"/)[1];
  const pass = await req(`login.${D}`, action, { method: "POST", body: `secret=secret&sandbox_id=${id}` });
  const done = await req(`login.${D}`, path(pass.location));
  assert.equal(done.location, back);
  const token = done.cookies.find((c) => c.startsWith("AUTHP_ACCESS_TOKEN="));
  assert.match(token ?? "", /; Domain=preview\.example\.com;/);

  const page = await req(`${UP}.${D}`);
  assert.equal(page.status, 200);
  assert.equal(page.body, `host=localhost:${UP} forwarded=${UP}.${D}:${PORT}`);
  assert.equal((await req(`${UP6}.${D}`)).body, "ipv6", "a server on [::1] only is reached too");
  assert.equal((await req(`5555.${D}`)).status, 502); // authorised and proxied; nothing listens there
  assert.equal((await req(`9090.${D}`)).status, 404);

  const ws = await new Promise((ok, ko) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    http.request({ host: "127.0.0.1", port: PORT, headers: { Host: `${UP}.${D}:${PORT}`, Cookie: cookie, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } })
      .on("upgrade", (res, sock) => { sock.destroy(); ok(res); }).on("response", (res) => ok(res)).on("error", ko).end();
  });
  assert.equal(ws.statusCode, 101);
  assert.equal(ws.headers["x-host"], `localhost:${UP}`);

  const out = await req(`login.${D}`, "/logout");
  assert.ok(out.cookies.some((c) => /^AUTHP_ACCESS_TOKEN=delete;.*Domain=preview\.example\.com;/.test(c)), "logout clears the shared cookie");
  assert.equal((await req(`${UP}.${D}`)).status, 302);
  assert.equal((await req(`${UP6}.${D}`)).status, 302);
});
