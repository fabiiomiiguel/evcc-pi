// Runs Caddy (as the current user, plain HTTP on a high port) with what `caddy-previews.sh --print` renders over the
// Everon render, and checks the source rule, the port rules, the shared login and the proxying. Needs the box's caddy
// (with caddy-security). Run: node --test nucbox/tests/previews.test.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 18480;
const UP = 4321; // an allowed preview port the test listens on
const UP6 = 4322; // another, listened on [::1] only
const D = "dev.example.com";
const EVERON = "everon.example.com";
const previews = fileURLToPath(new URL("../caddy-previews.sh", import.meta.url));
const everon = fileURLToPath(new URL("../caddy-everon-login.sh", import.meta.url));
const lib = fileURLToPath(new URL("../caddy-lib.sh", import.meta.url));
// requests from 127.0.0.1 stand for the tailnet, from [::1] for the LAN, from 127.0.0.2 for anyone else
const TAILNET = "127.0.0.1", LAN = "::1", OUTSIDER = "127.0.0.2";
const env = {
  ...process.env, CADDY_DOMAIN: "example.com", PREVIEW_DOMAIN: D, TAILNET_CIDR: "127.0.0.1/32", LAN_CIDR: "::1/128",
  EVERON_HOST: EVERON, EVERON_USER: "fabio",
  CLOUDFLARE_API_TOKEN: "x".repeat(40), AUTHP_SHARED_KEY: "a".repeat(64), AUTHP_PREVIEW_KEY: "b".repeat(64),
};
const dir = mkdtempSync(join(tmpdir(), "previews-"));
let caddy, upstream, upstream6;

const print = (script, file) => execFileSync("bash", [script, "--print", ...(file ? [file] : [])], { encoding: "utf8", env });

// Previews over the Everon render, moved to plain HTTP on PORT with a real hash and a writable store: nothing else changes.
function config() {
  const hash = execFileSync("caddy", ["hash-password", "--plaintext", "secret"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "everon"), print(everon));
  return print(previews, join(dir, "everon"))
    .replace("{\n", `{\n\tadmin off\n\tauto_https off\n\thttp_port ${PORT}\n`)
    .replace(/password "[^"]*"/, `password "bcrypt:${hash.split("$")[2]}:${hash}"`)
    .replace("/var/lib/caddy/authcrunch/users.json", join(dir, "users.json"))
    .replaceAll(`https://login.${D}/`, `http://login.${D}:${PORT}/`)
    .replace(/^(\*\.[^ ]+) \{/gm, `http://$1:${PORT} {`);
}

// jar: a session's cookies (name -> value), filled from Set-Cookie
function req(host, path = "/", { from = TAILNET, jar = {}, method = "GET", body, headers = {} } = {}) {
  return new Promise((ok, ko) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    const h = { Host: `${host}:${PORT}`, ...(cookie && { Cookie: cookie }), ...headers };
    if (body) Object.assign(h, { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) });
    const local = from === LAN ? { host: "::1" } : { host: "127.0.0.1", localAddress: from };
    const r = http.request({ ...local, port: PORT, path, method, headers: h }, (res) => {
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

// Logs in at the portal on host under prefix; returns the last answer (its location is the redirect back).
async function login(host, prefix, opts) {
  const user = await req(host, `${prefix}/login`, { ...opts, method: "POST", body: "username=fabio&realm=local" });
  // the password step is a form on the sandbox page, with its own id
  const form = (await req(host, path(user.location), opts)).body;
  const action = form.match(/action="([^"]+\/password-auth)"/)[1];
  const id = form.match(/name="sandbox_id"[^>]*value="([^"]+)"/)[1];
  const pass = await req(host, action, { ...opts, method: "POST", body: `secret=secret&sandbox_id=${id}` });
  return req(host, path(pass.location), opts);
}

before(async () => {
  upstream = http.createServer((q, s) => s.end(`host=${q.headers.host} forwarded=${q.headers["x-forwarded-host"]}`));
  upstream.on("upgrade", (q, sock) => sock.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Host: ${q.headers.host}\r\n\r\n`));
  await new Promise((ok) => upstream.listen(UP, "127.0.0.1", ok));
  upstream6 = http.createServer((q, s) => s.end("ipv6"));
  await new Promise((ok) => upstream6.listen(UP6, "::1", ok));
  writeFileSync(join(dir, "Caddyfile"), config());
  await start(env);
});

async function start(e) {
  caddy?.kill();
  if (caddy) await new Promise((ok) => caddy.once("exit", ok));
  caddy = spawn("caddy", ["run", "--config", join(dir, "Caddyfile")], { env: e, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await req(`${UP}.${D}`).then(() => true, () => false)) return;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error("caddy did not start");
}
after(() => {
  caddy?.kill();
  upstream?.close();
  upstream6?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("rendering again over its own output changes nothing but keeps the rest of the file", () => {
  const once = print(previews);
  const other = "other.example.com {\n\trespond 200\n}\n";
  const input = join(dir, "again");
  writeFileSync(input, once.replace("respond @outsiders 403", "respond @outsiders 418") + other);
  assert.equal(print(previews, input), once + other);
});

test("refused hosts get 404 before the login, from the tailnet and the LAN", async () => {
  for (const from of [TAILNET, LAN]) {
    for (const label of ["3000", "6768", "8080", "9090", "2999", "10000", "abc", "04321", "x4321"]) {
      assert.equal((await req(`${label}.${D}`, "/", { from })).status, 404, `${label} from ${from}`);
    }
  }
});

test("a source outside the tailnet and the LAN gets 403, login page included", async () => {
  for (const label of [UP, UP6, 9090, "abc", "login"]) {
    assert.equal((await req(`${label}.${D}`, "/", { from: OUTSIDER })).status, 403, String(label));
  }
});

test("without a session an allowed port goes to the login, from the LAN and the tailnet", async () => {
  for (const from of [LAN, TAILNET]) {
    const r = await req(`${UP}.${D}`, "/x?y=1", { from });
    assert.equal(r.status, 302, from);
    assert.match(r.location, new RegExp(`^http://login\\.${D}:${PORT}/\\?redirect_url=`));
    assert.equal((await req(`${UP6}.${D}`, "/", { from })).status, 302, "the [::1] fallback is behind the login too");
  }
});

test("one login from the LAN opens every allowed port for 30 days; cookie on PREVIEW_DOMAIN only; websockets pass; logout ends it", async () => {
  const jar = {};
  const opts = { from: LAN, jar };
  // the portal only keeps a redirect back to a preview (the browser's URL: https, no port)
  const portal = (url) => req(`login.${D}`, "/?redirect_url=" + encodeURIComponent(url), opts);
  assert.ok(!(await portal(`https://${EVERON}/`)).cookies.some((c) => c.startsWith("AUTHP_REDIRECT_URL=")));
  const back = `https://${UP}.${D}/x?y=1`;
  assert.ok((await portal(back)).cookies.some((c) => c.startsWith(`AUTHP_REDIRECT_URL=${back};`)));

  const done = await login(`login.${D}`, "", opts);
  assert.equal(done.location, back);
  const token = done.cookies.find((c) => c.startsWith("AUTHP_ACCESS_TOKEN="));
  assert.match(token ?? "", new RegExp(`; Domain=${D.replaceAll(".", "\\.")};`), "the cookie is for PREVIEW_DOMAIN, never its parent");
  assert.match(token ?? "", /; Max-Age=2592000(;|$)/, "the cookie outlives the browser session: 30 days");
  const claims = JSON.parse(Buffer.from(jar.AUTHP_ACCESS_TOKEN.split(".")[1], "base64url").toString());
  assert.ok(Math.abs(claims.exp - Date.now() / 1000 - 2592000) < 120, `token lifetime 30 days, exp=${claims.exp}`);

  for (const from of [LAN, TAILNET]) {
    const page = await req(`${UP}.${D}`, "/", { from, jar });
    assert.equal(page.status, 200, from);
    assert.equal(page.body, `host=localhost:${UP} forwarded=${UP}.${D}:${PORT}`);
  }
  assert.equal((await req(`${UP6}.${D}`, "/", opts)).body, "ipv6", "a server on [::1] only is reached too");
  assert.equal((await req(`5555.${D}`, "/", opts)).status, 502); // authorised and proxied; nothing listens there
  assert.equal((await req(`9090.${D}`, "/", opts)).status, 404);
  assert.equal((await req(`${UP}.${D}`, "/", { from: OUTSIDER, jar })).status, 403, "a session does not open it to outsiders");

  const ws = await new Promise((ok, ko) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    http.request({ host: "::1", port: PORT, headers: { Host: `${UP}.${D}:${PORT}`, Cookie: cookie, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } })
      .on("upgrade", (res, sock) => { sock.destroy(); ok(res); }).on("response", (res) => ok(res)).on("error", ko).end();
  });
  assert.equal(ws.statusCode, 101);
  assert.equal(ws.headers["x-host"], `localhost:${UP}`);

  const out = await req(`login.${D}`, "/logout", opts);
  assert.ok(out.cookies.some((c) => new RegExp(`^AUTHP_ACCESS_TOKEN=delete;.*Domain=${D.replaceAll(".", "\\.")};`).test(c)), "logout clears the shared cookie");
  assert.equal((await req(`${UP}.${D}`, "/", opts)).status, 302);
  assert.equal((await req(`${UP6}.${D}`, "/", opts)).status, 302);
});

test("tokens do not cross: Everon's is refused on the previews, a preview's on Everon", async () => {
  const ev = {};
  await login(EVERON, "/auth", { from: LAN, jar: ev });
  assert.equal((await req(EVERON, "/", { from: LAN, jar: ev })).status, 200, "Everon's token opens Everon");
  assert.equal((await req(`${UP}.${D}`, "/", { from: LAN, jar: ev })).status, 302, "Everon's token is not a preview session");

  const pv = {};
  await login(`login.${D}`, "", { from: LAN, jar: pv });
  assert.equal((await req(`${UP}.${D}`, "/", { from: LAN, jar: pv })).status, 200, "the preview token opens the previews");
  assert.notEqual((await req(EVERON, "/", { from: LAN, jar: pv })).status, 200, "a preview token (what a dev server sees) is not an Everon session");
});

// Last: restarts Caddy with the rotated key. The rotation's sudo part (backup, write, validate, restart, rollback) is in
// caddy-previews.sh --rotate-key; this checks what it writes and what a restart with it does to the sessions.
test("rotating the previews' key ends every preview session, not Everon's; a fresh login works", async () => {
  const ev = {}, pv = {};
  await login(EVERON, "/auth", { from: LAN, jar: ev });
  await login(`login.${D}`, "", { from: LAN, jar: pv });
  assert.equal((await req(`${UP}.${D}`, "/", { from: LAN, jar: pv })).status, 200);

  const before = `# comment\nCLOUDFLARE_API_TOKEN=${env.CLOUDFLARE_API_TOKEN}\nAUTHP_SHARED_KEY=${env.AUTHP_SHARED_KEY}\nAUTHP_PREVIEW_KEY=${env.AUTHP_PREVIEW_KEY}\nOTHER=1\n`;
  writeFileSync(join(dir, "env.old"), before);
  const out = execFileSync("bash", ["-c", `. "$0"; rotate_preview_key "$1" "$2"`, lib, join(dir, "env.old"), join(dir, "env.new")], { encoding: "utf8", env });
  assert.equal(out, "", "prints no secret");
  const after = readFileSync(join(dir, "env.new"), "utf8");
  const key = after.match(/^AUTHP_PREVIEW_KEY=(.*)$/m)?.[1] ?? "";
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, env.AUTHP_PREVIEW_KEY);
  assert.equal(after, before.replace(env.AUTHP_PREVIEW_KEY, key), "every other line kept");

  // Caddy gets what the rotated file holds, as the service would
  await start({ ...env, ...Object.fromEntries(after.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("="))) });
  assert.equal((await req(`${UP}.${D}`, "/", { from: LAN, jar: pv })).status, 302, "the old preview token is refused");
  assert.equal((await req(EVERON, "/", { from: LAN, jar: ev })).status, 200, "Everon's session survives");
  const fresh = {};
  await login(`login.${D}`, "", { from: LAN, jar: fresh });
  assert.equal((await req(`${UP}.${D}`, "/", { from: LAN, jar: fresh })).status, 200, "a fresh login works");
});

test("a failing openssl never writes an empty key: nothing is written, so nothing is restarted", () => {
  const bin = join(dir, "stub-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "openssl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const old = join(dir, "env.keep"), out = join(dir, "env.none");
  writeFileSync(old, "AUTHP_PREVIEW_KEY=abc\n");
  const r = spawnSync("bash", ["-c", `. "$0"; rotate_preview_key "$1" "$2"`, lib, old, out], { encoding: "utf8", env: { ...env, PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(out), false, "no output file");
  assert.equal(readFileSync(old, "utf8"), "AUTHP_PREVIEW_KEY=abc\n");
});
