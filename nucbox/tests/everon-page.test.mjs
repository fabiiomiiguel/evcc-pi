// Runs the wrapper page script that `caddy-everon-login.sh --print` renders against stubs of the iframe and noVNC's
// <html> class states. Run: node --test nucbox/tests/everon-page.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../caddy-everon-login.sh", import.meta.url));
const page = execFileSync("bash", [script, "--print"], { encoding: "utf8" });
const js = page.match(/<script>([\s\S]*?)<\/script>/)[1];

// fetchResult: a response-like object, or "fail" for a network error.
function boot(fetchResult) {
  const log = { replaced: [], fetched: [], reloads: 0 };
  const timers = [];
  const classes = new Set();
  classes.contains = (n) => classes.has(n);
  let observer;
  const listeners = {};
  const disc = { listener: null };
  const el = { textContent: "", appendChild: () => ({ style: {} }) };
  const doc = {
    documentElement: { classList: classes },
    head: { appendChild: () => ({}) },
    createElement: () => ({ style: {} }),
    getElementById: (id) => id === "noVNC_disconnect_button" ? { addEventListener: (_, fn) => (disc.listener = fn) } : el,
  };
  const iframe = {
    contentDocument: doc,
    _src: "",
    get src() { return this._src; },
    set src(v) { this._src = v; log.reloads++; },
    addEventListener: (type, fn) => (listeners.load = fn),
  };
  const ctx = {
    document: { querySelector: () => iframe },
    window: undefined,
    navigator: { platform: "Linux x86_64" },
    location: { replace: (u) => log.replaced.push(u) },
    addEventListener: (type, fn) => (listeners[type] = fn),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    MutationObserver: class { constructor(cb) { observer = cb; } observe() {} },
    fetch: (url, opts) => {
      log.fetched.push(url);
      return fetchResult === "fail" ? Promise.reject(new Error("net")) : Promise.resolve(fetchResult);
    },
  };
  vm.runInNewContext(js, ctx);
  log.reloads = 0; // the initial f.src assignment
  const setState = (...names) => { classes.clear(); names.forEach((n) => classes.add("noVNC_" + n)); observer?.(); };
  return { ctx, log, listeners, iframe, timers, setState, load: () => listeners.load(), click: () => disc.listener(), disc };
}
const flush = async (t) => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); while (t.timers.length) t.timers.shift().fn(); await new Promise((r) => setImmediate(r)); };
const redirect = { type: "opaqueredirect", ok: false };
const okRes = { type: "basic", ok: true };

test("pageshow restored from bfcache reloads the page", () => {
  const t = boot(okRes);
  let reloaded = 0;
  t.ctx.location.reload = () => reloaded++;
  t.listeners.pageshow({ persisted: false });
  assert.equal(reloaded, 0);
  t.listeners.pageshow({ persisted: true });
  assert.equal(reloaded, 1);
});

test("unexpected disconnect + session gone goes to the login", async () => {
  const t = boot(redirect);
  t.load(); t.setState("connected"); t.setState();
  await flush(t);
  assert.deepEqual(t.log.replaced, ["/"]);
});

test("unexpected disconnect + valid session reloads the iframe, capped", async () => {
  const t = boot(okRes);
  t.load(); t.setState("connected"); t.setState();
  await flush(t);
  assert.deepEqual(t.log.replaced, []);
  assert.equal(t.log.reloads, 1);
  for (let i = 0; i < 6; i++) { t.load(); t.setState("connecting"); t.setState(); await flush(t); }
  assert.equal(t.log.reloads, 3);
});

test("network error during the check retries instead of throwing", async () => {
  const t = boot("fail");
  t.load(); t.setState("connected"); t.setState();
  await flush(t);
  assert.equal(t.log.reloads, 1);
});

test("the Disconnect click path makes no check and no reconnect", async () => {
  const t = boot(okRes);
  t.ctx.fetch = (url) => { t.log.fetched.push(url); return Promise.resolve(okRes); };
  t.load(); t.setState("connected");
  t.click();
  t.setState("disconnecting"); t.setState();
  await flush(t);
  assert.ok(!t.log.fetched.includes("/vnc.html"));
  assert.equal(t.log.reloads, 0);
  assert.ok(t.log.fetched.includes("/auth/logout"));
  assert.deepEqual(t.log.replaced, ["/"]);
});

test("the initial not-yet-connected state does not trigger a check", async () => {
  const t = boot(okRes);
  t.load(); t.setState();
  await flush(t);
  assert.deepEqual(t.log.fetched, []);
});
