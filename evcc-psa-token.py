#!/usr/bin/env python3
"""evcc-psa-token — renews the Stellantis OAuth tokens evcc uses.

Replaces the manual ritual (stelloauth site -> `evcc token` -> edit
evcc.yaml -> restart the service) with a single command. Runs on the Pi.

    evcc-psa-token init            set up account and password
    evcc-psa-token status          is the token alive? (changes nothing)
    evcc-psa-token check           renew only if actually broken  <- timer/cron
    evcc-psa-token renew           always renew
    evcc-psa-token install-timer   daily automatic check
    evcc-psa-token remove-timer

Options: --country XX  --dry-run  --no-restart  -v

Standard library only. Tested on Python 3.11+.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

VERSION = "2.1.0"
CONF_PATH = os.environ.get("EVCC_PSA_CONF", "/etc/evcc-psa-token.conf")

# --------------------------------------------------------------------------
# A NOTE ON COUNTRIES
#
# Stellantis uses two client_ids per brand and evcc only has ONE hardcoded
# (vehicle/psa/oauth2.go). Portugal belongs to the *other* group:
#
#   1eebc2d5-…  AT BE CH CZ DE DK ES FI FR GB GR HU IE IT LU NL NO …  <- evcc's
#   4166e1cd-…  BR CL LT LV PL PT RO RU SE SI SK TR UA ZA …
#
# Ask for the OAuth code with country=PT and the refresh_token is issued to
# 4166e1cd; evcc renews with 1eebc2d5 and gets invalid_grant as soon as the
# access token expires. That is why the token kept dying and the whole ritual
# had to be repeated. So by default we ask for the code using a compatible
# country (ES): same account, same IDP, only the login page language changes.
# --------------------------------------------------------------------------

# client_id/secret evcc has hardcoded, per brand
EVCC_CLIENTS = {
    "peugeot": ("1eebc2d5-5df3-459b-a624-20abfcf82530",
                "T5tP7iS0cO8sC0lA2iE2aR7gK6uE5rF3lJ8pC3nO1pR7tL8vU1"),
    "citroen": ("5364defc-80e6-447b-bec6-4af8d1542cae",
                "iE0cD8bB0yJ0dS6rO3nN1hI2wU7uA5xR4gP7lD6vM0oH0nS8dN"),
    "opel":    ("07364655-93cb-4194-8158-6b035ac2c24c",
                "F2kK7lC5kF5qN7tM0wT8kE3cW1dP0wC5pI6vC0sQ5iP5cN8cJ8"),
    "ds":      ("cbf74ee7-a303-4c3d-aba3-29f5994e2dfa",
                "X6bE6yQ3tH1cG5oA6aW4fS6hK0cR0aK5yN2wE4hP8vL8oW5gU3"),
}

# slug -> (idp, realm, redirect_uri scheme)
BRAND_INFO = {
    "peugeot": ("https://idpcvs.peugeot.com", "clientsB2CPeugeot", "mymap"),
    "citroen": ("https://idpcvs.citroen.com", "clientsB2CCitroen", "mymacsdk"),
    "opel":    ("https://idpcvs.opel.com", "clientsB2COpel", "mymopsdk"),
    "ds":      ("https://idpcvs.driveds.com", "clientsB2CDS", "mymdssdk"),
}

# stelloauth brand -> evcc slug
BRAND_SLUG = {
    "MyPeugeot": "peugeot",
    "MyCitroen": "citroen",
    "MyOpel": "opel",
    "MyVauxhall": "opel",
    "MyDS": "ds",
}

PSA_API = "https://api.groupe-psa.com/connectedcar/v4"

DEFAULTS = {
    "BRAND": "MyPeugeot",
    "ACCOUNT_COUNTRY": "PT",
    "EMAIL": "",
    "PASSWORD": "",
    "VEHICLE": "e208",
    "EVCC_YAML": "/etc/evcc.yaml",
    "EVCC_DB": "/var/lib/evcc/evcc.db",
    "EVCC_SERVICE": "evcc",
    "EVCC_API": "http://localhost:7070",
    "STELLO_URL": "https://stelloauth.tollet.me",
    "PREFERRED_COUNTRIES": "ES FR IT DE GB",
    "KEEP_BACKUPS": "5",
}


class Fail(Exception):
    """Expected error: exit with a message, no traceback."""


# ------------------------------------------------------------------- output
_TTY = sys.stdout.isatty()
_C = {
    "ok": "\033[0;32m" if _TTY else "",
    "err": "\033[0;31m" if _TTY else "",
    "warn": "\033[0;33m" if _TTY else "",
    "dim": "\033[2m" if _TTY else "",
    "b": "\033[1m" if _TTY else "",
    "0": "\033[0m" if _TTY else "",
}
VERBOSE = False


# warnings and debug go to stderr: some functions return through stdout
def log(msg: str = "") -> None:
    print(msg, flush=True)


def ok(msg: str) -> None:
    print(f"{_C['ok']}✓{_C['0']} {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"{_C['warn']}!{_C['0']} {msg}", file=sys.stderr, flush=True)


def dbg(msg: str) -> None:
    if VERBOSE:
        print(f"{_C['dim']}· {msg}{_C['0']}", file=sys.stderr, flush=True)


def mask(tok: str | None) -> str:
    if not tok:
        return "(empty)"
    return f"{tok[:8]}…{tok[-4:]}" if len(tok) > 14 else "…"


# --------------------------------------------------------------------- http
# urllib's default User-Agent trips Cloudflare (error 1010)
USER_AGENT = f"evcc-psa-token/{VERSION}"


def http(url: str, *, data: bytes | None = None, headers: dict | None = None,
         method: str | None = None, timeout: float = 30) -> tuple[int, bytes]:
    """Returns (status, body). Does not raise on 4xx/5xx."""
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:          # 4xx/5xx: the body matters
        return e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        dbg(f"{url}: {e}")
        return 0, b""


def http_json(url: str, **kw) -> tuple[int, dict]:
    status, body = http(url, **kw)
    try:
        return status, json.loads(body)
    except (ValueError, TypeError):
        return status, {}


# --------------------------------------------------------------------- conf
def load_conf(path: str) -> dict:
    """Reads the KEY="value" file (shell syntax, so both worlds can read it)."""
    cfg = dict(DEFAULTS)
    if not os.path.exists(path):
        return cfg
    if not os.access(path, os.R_OK):
        warn(f"{path} is not readable by {os.environ.get('USER', 'this user')}"
             " — falling back to defaults")
        return cfg
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            try:
                parts = shlex.split(line, comments=True)
            except ValueError:
                continue
            if not parts or "=" not in parts[0]:
                continue
            key, _, val = " ".join(parts).partition("=")
            cfg[key.strip()] = val
    dbg(f"config: {path}")
    return cfg


def write_conf(path: str, cfg: dict) -> None:
    # Every key, not just the ones init asks about — otherwise changing the
    # password would silently drop a customised EVCC_API or KEEP_BACKUPS and
    # the tool would quietly fall back to defaults.
    first = ["BRAND", "ACCOUNT_COUNTRY", "EMAIL", "PASSWORD", "VEHICLE"]
    order = first + [k for k in DEFAULTS if k not in first]
    lines = ["# evcc-psa-token configuration — root-readable only (0600)"]
    for key in order:
        lines.append(f"{key}={shlex.quote(cfg.get(key, DEFAULTS.get(key, '')))}")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def require_root(cfg: dict) -> None:
    if os.geteuid() != 0:
        raise Fail(f"must run as root (use: sudo {sys.argv[0]} …)")


def require_credentials(cfg: dict) -> None:
    if not cfg["EMAIL"]:
        raise Fail(f"EMAIL not set in {CONF_PATH}. Run: {sys.argv[0]} init")
    if not cfg["PASSWORD"]:
        # without a stored password this can only be run by hand
        if not sys.stdin.isatty():
            raise Fail(f"PASSWORD not set in {CONF_PATH}. Run: {sys.argv[0]} init")
        cfg["PASSWORD"] = getpass.getpass(
            f"Password for the {cfg['BRAND']} account ({cfg['EMAIL']}): ")
        if not cfg["PASSWORD"]:
            raise Fail("empty password")


def brand_slug(cfg: dict) -> str:
    slug = BRAND_SLUG.get(cfg["BRAND"])
    if not slug:
        raise Fail(f"unknown brand: {cfg['BRAND']} "
                   f"(use one of {', '.join(BRAND_SLUG)})")
    return slug


# -------------------------------------------------------------- token state
def current_access_token(cfg: dict, slug: str) -> tuple[str, str]:
    """The token in use and where it came from: ("db" | "yaml" | "").

    The database wins over the yaml — evcc stores the renewed token there and
    that is the one it uses. The source matters: see health().
    """
    db, email = cfg["EVCC_DB"], cfg["EMAIL"].lower()
    if email and os.path.exists(db):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                row = con.execute("select value from settings where key=?",
                                  (f"psa.{slug}.{email}",)).fetchone()
            finally:
                con.close()
            if row and row[0]:
                tok = json.loads(row[0]).get("access_token", "")
                if tok:
                    dbg("token read from evcc's database")
                    return tok, "db"
        except (sqlite3.Error, ValueError) as e:
            dbg(f"database: {e}")
    try:
        with open(cfg["EVCC_YAML"], encoding="utf-8") as fh:
            m = re.search(r"(?m)^[^\S\n]*accessToken:[^\S\n]*(\S+)", fh.read())
            if m:
                dbg("token read from evcc.yaml")
                return m.group(1), "yaml"
    except OSError:
        pass
    return "", ""


def health(cfg: dict, slug: str) -> tuple[bool, str]:
    """(healthy, explanation) — without consuming or rotating the refresh token.

    An expired access token means nothing bad: it lasts ~1 h and evcc renews
    it when needed. The reliable signal is elsewhere — in evcc's identity.go,
    when the refresh fails with invalid_grant it DELETES the settings key
    psa.<brand>.<email> from the database. So:

        key present         -> evcc still has a refresh token it trusts
        key missing + 401   -> evcc gave up, the login has to be repeated

    Treating 401 as a failure made the timer run a full renewal every day for
    no reason, and every renewal sends the account password to the login service.
    """
    token, source = current_access_token(cfg, slug)
    if not token:
        return False, "no token at all (neither in the database nor in evcc.yaml)"

    status = psa_probe(slug, token)
    if status == 200:
        return True, "the Stellantis API answered 200"
    if status == 0:
        return False, "no network route to the Stellantis API"
    if status == 401 and source == "db":
        return True, ("access token expired, but evcc still holds the refresh "
                      "token — it renews on its own when needed")
    if status == 401:
        return False, "token expired and evcc no longer holds a refresh token"
    return False, f"unexpected answer from the API: HTTP {status}"


def psa_probe(slug: str, token: str) -> int:
    """200 = token alive, 401 = expired, 0 = no network."""
    if not token:
        return 0
    _, realm, _ = BRAND_INFO[slug]
    client_id = EVCC_CLIENTS[slug][0]
    url = f"{PSA_API}/user/vehicles?" + urllib.parse.urlencode({"client_id": client_id})
    status, _ = http(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/hal+json",
        "X-Introspect-Realm": realm,
    }, timeout=25)
    return status


def psa_vehicles(slug: str, token: str) -> list[dict]:
    _, realm, _ = BRAND_INFO[slug]
    url = f"{PSA_API}/user/vehicles?" + urllib.parse.urlencode(
        {"client_id": EVCC_CLIENTS[slug][0]})
    status, body = http_json(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/hal+json",
        "X-Introspect-Realm": realm,
    }, timeout=25)
    if status != 200:
        return []
    return (body.get("_embedded") or {}).get("vehicles", []) or []


# ------------------------------------------------------------------- oauth
def stello_configs(cfg: dict) -> dict:
    # the public service sits behind Cloudflare and can take ~40 s from a Pi 3
    status, body = http_json(f"{cfg['STELLO_URL']}/configs", timeout=90)
    if status != 200 or not body:
        host = cfg["STELLO_URL"]
        if "127.0.0.1" in host or "localhost" in host:
            # never fall back to the public service silently: the password
            # would end up there
            raise Fail(f"the local stelloauth ({host}) is not answering — "
                       "check 'systemctl status stelloauth'")
        raise Fail(f"could not fetch {host}/configs")
    return body


def pick_country(cfg: dict, slug: str, want: str | None) -> tuple[str, str, str]:
    """Returns (country, client_id, client_secret) to request the code with.

    The client must be the SAME for the request and for the exchange: a code
    issued to client A cannot be exchanged by client B. That is why the client
    comes from stelloauth's /configs and not from a constant.
    """
    configs = stello_configs(cfg)
    brand_cfg = configs.get(cfg["BRAND"], {}).get("configs", {})
    if not brand_cfg:
        raise Fail(f"stelloauth does not know the brand {cfg['BRAND']}")
    evcc_id, evcc_secret = EVCC_CLIENTS[slug]

    if want:
        entry = brand_cfg.get(want.upper())
        if not entry:
            raise Fail(f"country '{want}' does not exist for {cfg['BRAND']}")
        if entry["client_id"] != evcc_id:
            warn(f"country {want.upper()} uses client {entry['client_id'][:8]}… "
                 f"while evcc renews with {evcc_id[:8]}…:")
            warn("the token will work, but evcc will not be able to renew it "
                 "on its own — it will die when it expires.")
        return want.upper(), entry["client_id"], entry["client_secret"]

    candidates = [cfg["ACCOUNT_COUNTRY"]] + cfg["PREFERRED_COUNTRIES"].split()
    for country in candidates:
        country = country.upper()
        entry = brand_cfg.get(country)
        if entry and entry["client_id"] == evcc_id:
            if country != cfg["ACCOUNT_COUNTRY"].upper():
                dbg(f"{cfg['ACCOUNT_COUNTRY']} is not compatible with evcc's "
                    f"client, using {country}")
            return country, evcc_id, evcc_secret
    raise Fail(f"no country compatible with evcc's client_id ({evcc_id}) "
               f"among: {' '.join(candidates)}")


def get_oauth_code(cfg: dict, country: str) -> str:
    """Headless login through stelloauth -> OAuth code.

    Tries the SSE mode first (live progress — headless Chromium on a Pi 3
    takes about a minute); falls back to reading the JSON response.
    """
    payload = json.dumps({
        "brand": cfg["BRAND"],
        "country": country,
        "email": cfg["EMAIL"],
        "password": cfg["PASSWORD"],
    }).encode()
    url = f"{cfg['STELLO_URL']}/oauth"
    req = urllib.request.Request(url, data=payload, headers={
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    })
    try:
        # headless Chromium on a Pi 3 is slow: give it room
        resp = urllib.request.urlopen(req, timeout=480)
    except urllib.error.HTTPError as e:
        return _oauth_code_from_json(e.read(), e.code)
    except (urllib.error.URLError, OSError) as e:
        raise Fail(f"could not reach {url}: {e}") from None

    with resp:
        if "text/event-stream" not in (resp.headers.get("Content-Type") or ""):
            return _oauth_code_from_json(resp.read(), resp.status)
        return _oauth_code_from_sse(resp)


def _oauth_code_from_json(raw: bytes, status: int) -> str:
    try:
        body = json.loads(raw)
    except ValueError:
        raise Fail(f"unreadable answer from stelloauth (HTTP {status})") from None
    if body.get("status") == "error":
        raise Fail(f"login failed: {body.get('message') or 'unknown error'}")
    code = (body.get("data") or {}).get("code")
    if not code:
        raise Fail(f"stelloauth answered without a code: {str(body)[:200]}")
    return code


def _oauth_code_from_sse(resp) -> str:
    """Consumes the event stream and returns the code."""
    last = ""
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip())
        except ValueError:
            continue
        kind, msg = ev.get("type"), ev.get("message", "")
        if kind == "success":
            if _TTY and last:
                print("\r" + " " * (len(last) + 6) + "\r", end="")
            code = ev.get("code", "")
            if not code:
                raise Fail("stelloauth reported success but sent no code")
            return code
        if kind == "error":
            if _TTY and last:
                print()
            raise Fail(f"login failed: {msg or 'unknown error'}")
        if kind == "debug":
            dbg(msg)
        elif kind == "progress":
            last = msg
            if _TTY:
                print(f"\r     {_C['dim']}{msg}{_C['0']}\033[K", end="", flush=True)
            else:
                dbg(msg)
    raise Fail("stelloauth closed the connection without returning a code")


def exchange_code(slug: str, country: str, code: str,
                  client_id: str, client_secret: str) -> tuple[str, str]:
    """OAuth code -> (access, refresh).

    The client must be the one the code was requested with (see pick_country).
    """
    idp, _, scheme = BRAND_INFO[slug]
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": f"{scheme}://oauth2redirect/{country.lower()}",
    }).encode()
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    status, body = http_json(f"{idp}/am/oauth2/access_token", data=data, headers={
        "Authorization": f"Basic {basic}",
        "Content-Type": "application/x-www-form-urlencoded",
    }, timeout=40)
    if not body:
        raise Fail(f"no answer from the token endpoint (HTTP {status})")
    if body.get("error"):
        raise Fail(f"code exchange failed: {body['error']} — "
                   f"{body.get('error_description', '')}")
    access, refresh = body.get("access_token"), body.get("refresh_token")
    if not access or not refresh:
        raise Fail(f"answer without tokens: {str(body)[:200]}")
    return access, refresh


# -------------------------------------------------------------------- evcc
H = r"[^\S\n]"          # horizontal space: never let \s swallow the newlines


def patch_yaml(path: str, vehicle: str, access: str, refresh: str) -> None:
    """Replaces only the two token lines inside the vehicle's block."""
    with open(path, encoding="utf-8") as fh:
        src = fh.read()

    m = re.search(rf"(?m)^{H}*-{H}*name:{H}*{re.escape(vehicle)}{H}*$", src)
    if not m:
        raise Fail(f"vehicle '{vehicle}' not found in {path}")
    start = m.start()
    nxt = re.search(rf"(?m)^{H}*-{H}*name:", src[m.end():])
    end = m.end() + nxt.start() if nxt else len(src)
    block = src[start:end]

    changed = 0
    for key, val in (("accessToken", access), ("refreshToken", refresh)):
        block, n = re.subn(rf"(?m)^({H}*{key}:{H}*)\S+{H}*$",
                           lambda mo, v=val: mo.group(1) + v, block)
        changed += n
    if changed != 2:
        raise Fail(f"accessToken/refreshToken not found in the '{vehicle}' block")

    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(src[:start] + block + src[end:])
    shutil.copymode(path, tmp)
    os.replace(tmp, path)


def backup_yaml(path: str, keep: int) -> str:
    # keep >= 1: with 0 the pruning below would delete the copy we just made,
    # and the rollback in cmd_renew would have nothing to restore from
    keep = max(1, keep)
    folder = "/var/backups"     # Debian's home for exactly this kind of copy
    os.makedirs(folder, exist_ok=True)
    prefix = os.path.basename(path) + ".bak-"
    dest = os.path.join(folder, f"{prefix}{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(path, dest)
    dbg(f"backup: {dest}")
    old = sorted((f for f in os.listdir(folder) if f.startswith(prefix)),
                 reverse=True)[keep:]
    for f in old:
        try:
            os.remove(os.path.join(folder, f))
        except OSError:
            pass
    return dest


def clear_db_token(cfg: dict, slug: str) -> bool:
    """Deletes the stored token — otherwise it overrides the one in the yaml."""
    db, email = cfg["EVCC_DB"], cfg["EMAIL"].lower()
    if not os.path.exists(db):
        return False
    key = f"psa.{slug}.{email}"
    try:
        con = sqlite3.connect(db)
        try:
            n = con.execute("delete from settings where key=?", (key,)).rowcount
            con.commit()
        finally:
            con.close()
    except sqlite3.Error as e:
        warn(f"could not clear key {key} from the database: {e}")
        return False
    if n:
        dbg(f"removed from the database: {key}")
    return bool(n)


def systemctl(*args: str) -> int:
    return subprocess.run(["systemctl", *args], check=False).returncode


# ---------------------------------------------------------------- commands
def cmd_status(cfg: dict, _args) -> int:
    slug = brand_slug(cfg)
    token, source = current_access_token(cfg, slug)
    log(f"{_C['b']}evcc-psa-token{_C['0']} v{VERSION}")
    log(f"  brand/vehicle : {cfg['BRAND']} / {cfg['VEHICLE']}")
    log(f"  account       : {cfg['EMAIL'] or '(not configured)'}")
    log(f"  stelloauth    : {cfg['STELLO_URL']}")
    log(f"  access token  : {mask(token)}"
        + (f"  (from {'evcc database' if source == 'db' else 'evcc.yaml'})"
           if source else ""))
    healthy, why = health(cfg, slug)
    if healthy:
        ok(why)
        return 0
    warn(f"{why} — run '{sys.argv[0]} renew'")
    return 1


def cmd_renew(cfg: dict, args, force: bool) -> int:
    require_root(cfg)
    slug = brand_slug(cfg)
    if not os.path.exists(cfg["EVCC_YAML"]):
        raise Fail(f"{cfg['EVCC_YAML']} does not exist")

    if not force:
        healthy, why = health(cfg, slug)
        if healthy:
            ok(f"nothing to do — {why}")
            return 0
        log(f"{why} — renewing…")

    country, client_id, client_secret = pick_country(cfg, slug, args.country)
    require_credentials(cfg)

    host = cfg["STELLO_URL"].split("//")[-1]
    log(f"1/5  logging in to {cfg['BRAND']} ({country}) through {host}…")
    try:
        code = get_oauth_code(cfg, country)
    except Fail as e:
        alt = [c for c in cfg["PREFERRED_COUNTRIES"].split()
               if c.upper() != country.upper()][:3]
        if alt:
            # the helper depends on the page language; another country that
            # is compatible with evcc's client usually sorts it out
            raise Fail(f"{e}\n  If the credentials are right, try another "
                       f"compatible country: --country "
                       f"{' | --country '.join(alt)}") from None
        raise
    ok(f"OAuth code obtained: {mask(code)}")

    log("2/5  exchanging the code for tokens…")
    access, refresh = exchange_code(slug, country, code, client_id, client_secret)
    ok(f"access {mask(access)}   refresh {mask(refresh)}")

    if args.dry_run:
        warn(f"--dry-run: {cfg['EVCC_YAML']} was left untouched")
        log(f"accessToken: {access}")
        log(f"refreshToken: {refresh}")
        return 0

    log(f"3/5  updating {cfg['EVCC_YAML']}…")
    try:
        keep = int(cfg["KEEP_BACKUPS"])
    except (TypeError, ValueError):
        keep = int(DEFAULTS["KEEP_BACKUPS"])
    backup = backup_yaml(cfg["EVCC_YAML"], keep)
    try:
        patch_yaml(cfg["EVCC_YAML"], cfg["VEHICLE"], access, refresh)
    except Exception:
        shutil.copy2(backup, cfg["EVCC_YAML"])
        raise
    ok(f"tokens written (backup in {backup})")

    if not args.no_restart:
        log("4/5  restarting evcc…")
        systemctl("stop", cfg["EVCC_SERVICE"])
        clear_db_token(cfg, slug)
        if systemctl("start", cfg["EVCC_SERVICE"]) != 0:
            raise Fail(f"the {cfg['EVCC_SERVICE']} service did not start — "
                       f"check 'journalctl -u {cfg['EVCC_SERVICE']} -n 50'")
        ok(f"{cfg['EVCC_SERVICE']} service restarted")
    else:
        warn(f"--no-restart: restart with 'systemctl restart {cfg['EVCC_SERVICE']}'")
        return 0

    log("5/5  verifying…")
    status = 0
    for _ in range(12):
        status = psa_probe(slug, access)
        if status == 200:
            break
        time.sleep(2)
    if status == 200:
        cars = ", ".join(
            f"{v.get('brand', '')} {v.get('label', '')} ({v.get('vin', '')})".strip()
            for v in psa_vehicles(slug, access))
        ok(f"Stellantis API OK{' — ' + cars if cars else ''}")
    else:
        warn(f"the API answered {status} — "
             f"check 'journalctl -u {cfg['EVCC_SERVICE']} -f'")

    if http(f"{cfg['EVCC_API']}/api/state", timeout=10)[0] == 200:
        ok(f"evcc answering on {cfg['EVCC_API']}")
    return 0


def cmd_init(cfg: dict, _args) -> int:
    require_root(cfg)

    def ask(label: str, key: str) -> str:
        current = cfg.get(key, "")
        value = input(f"{label} [{current}]: ").strip()
        return value or current

    cfg["EMAIL"] = ask("Account email", "EMAIL")
    cfg["BRAND"] = ask("Brand (MyPeugeot/MyCitroen/MyOpel/MyDS)", "BRAND")
    cfg["ACCOUNT_COUNTRY"] = ask("Account country", "ACCOUNT_COUNTRY")
    cfg["VEHICLE"] = ask("Vehicle name in evcc.yaml", "VEHICLE")
    cfg["STELLO_URL"] = ask("stelloauth URL", "STELLO_URL")
    brand_slug(cfg)   # validate the brand right here

    log("")
    log("The password is stored in plain text in the file (0600, root only) —")
    log("that is what allows unattended renewal. Leave it empty to be asked")
    log("every time.")
    while True:
        pw1 = getpass.getpass(
            f"Password for the {cfg['BRAND']} account (Enter = do not store): ")
        if not pw1:
            cfg["PASSWORD"] = ""
            break
        if pw1 == getpass.getpass("Repeat the password: "):
            cfg["PASSWORD"] = pw1
            break
        warn("they do not match, try again")

    write_conf(CONF_PATH, cfg)
    ok(f"wrote {CONF_PATH} (0600 root)")
    log(f"Now run: sudo {sys.argv[0]} renew")
    return 0


SERVICE_UNIT = """[Unit]
Description=Renew evcc's Stellantis tokens when they expire
After=network-online.target evcc.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart={exe} check
"""

TIMER_UNIT = """[Unit]
Description=Daily check of evcc's Stellantis tokens

[Timer]
OnBootSec=5min
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
"""


def cmd_install_timer(cfg: dict, _args) -> int:
    require_root(cfg)
    if not cfg["PASSWORD"]:
        raise Fail("without a stored PASSWORD the timer cannot run unattended. "
                   f"Run this first: {sys.argv[0]} init")
    exe = os.path.realpath(sys.argv[0])
    with open("/etc/systemd/system/evcc-psa-token.service", "w") as fh:
        fh.write(SERVICE_UNIT.format(exe=exe))
    with open("/etc/systemd/system/evcc-psa-token.timer", "w") as fh:
        fh.write(TIMER_UNIT)
    systemctl("daemon-reload")
    if systemctl("enable", "--now", "evcc-psa-token.timer") != 0:
        raise Fail("could not enable the timer")
    ok("timer installed — 5 min after boot and every day at 04:30")
    systemctl("list-timers", "evcc-psa-token.timer", "--no-pager")
    return 0


def cmd_remove_timer(cfg: dict, _args) -> int:
    require_root(cfg)
    systemctl("disable", "--now", "evcc-psa-token.timer")
    for f in ("/etc/systemd/system/evcc-psa-token.service",
              "/etc/systemd/system/evcc-psa-token.timer"):
        try:
            os.remove(f)
        except FileNotFoundError:
            pass
    systemctl("daemon-reload")
    ok("timer removed")
    return 0


# -------------------------------------------------------------------- main
def main(argv: list[str]) -> int:
    global VERBOSE

    p = argparse.ArgumentParser(
        prog="evcc-psa-token",
        description="Renews the Stellantis OAuth tokens evcc uses.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  sudo evcc-psa-token init\n"
               "  sudo evcc-psa-token renew\n"
               "  sudo evcc-psa-token renew --country PT --dry-run\n")
    p.add_argument("command", nargs="?", default="status",
                   choices=["status", "check", "renew", "init",
                            "install-timer", "remove-timer"],
                   help="status (default), check, renew, init, "
                        "install-timer, remove-timer")
    p.add_argument("--country", metavar="XX",
                   help="force the country used to request the OAuth code")
    p.add_argument("--dry-run", action="store_true",
                   help="show the new tokens without touching evcc.yaml")
    p.add_argument("--no-restart", action="store_true",
                   help="do not restart the evcc service")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    args = p.parse_args(argv)
    VERBOSE = args.verbose

    cfg = load_conf(CONF_PATH)
    handlers = {
        "status": cmd_status,
        "check": lambda c, a: cmd_renew(c, a, force=False),
        "renew": lambda c, a: cmd_renew(c, a, force=True),
        "init": cmd_init,
        "install-timer": cmd_install_timer,
        "remove-timer": cmd_remove_timer,
    }
    return handlers[args.command](cfg, args)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Fail as exc:
        print(f"{_C['err']}✗{_C['0']} {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print()
        sys.exit(130)
