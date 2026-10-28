# evcc-psa-token

Renews the Stellantis (MyPeugeot) OAuth tokens evcc uses to read the e-208's
state — no website to visit, no hand-editing of `evcc.yaml`. Everything runs
on the Raspberry Pi.

## The ritual this replaces

1. open <https://stelloauth.tollet.me>, pick brand/country, log in → OAuth code
2. `sudo evcc --database /var/lib/evcc/evcc.db token e208` and paste the code
3. copy `accessToken`/`refreshToken` into `/etc/evcc.yaml`
4. `sudo systemctl restart evcc`

Now: `sudo evcc-psa-token renew`.

## Why the token kept dying

Stellantis has **two `client_id`s per brand** and evcc only knows one of them
(`vehicle/psa/oauth2.go`, hardcoded):

| client_id    | countries                                                        |
| ------------ | ---------------------------------------------------------------- |
| `1eebc2d5-…` | AT BE CH CZ DE DK **ES FR** GB GR HU IE IT LU NL NO … ← evcc's    |
| `4166e1cd-…` | BR CL LT LV PL **PT** RO RU SE SI SK TR UA ZA …                  |

Ask for the OAuth code with **country = PT** and the `refresh_token` is issued
to `4166e1cd`. evcc renews with `1eebc2d5` → `invalid_grant` → the token dies as
soon as the access token expires, and the whole ritual starts over.

The script picks a compatible country automatically (**ES** by default) — same
account, same IDP, only the login page language changes — and evcc can then
renew on its own. `--country PT` forces it, with a warning that the token will
not be renewable.

## Who does the login

The Stellantis login goes through Gigya (SAP Customer Data Cloud) and Gigya's
`accounts.login` **requires a CAPTCHA** — verified: a direct POST returns
`Invalid CaptchaType / Invalid CaptchaToken`. There is no pure-HTTP way in; a
real browser is required.

By default we use <https://stelloauth.tollet.me>, which does that for us in a
headless Chrome — so **the MyPeugeot password goes through it**, exactly as it
did in the manual flow. It is a third-party service; the code is open source
([tamcore/stelloauth](https://github.com/tamcore/stelloauth)).

To avoid depending on it, `install-stelloauth.py` installs the same helper on
the Pi itself (Go + headless Chromium, listening on `127.0.0.1:8099` only) —
see [Optional: local helper](#optional-local-helper).

**Since September 2026 the local helper is required**: the public instance
stopped publishing which `client_id` it uses per country, and the codes it
issues can no longer be exchanged with evcc's client (`invalid_grant`).

## Install

```bash
cp .env.example .env && chmod 600 .env   # fill in: PI, EV_USER, EV_VIN, EMMA_HOST…
./deploy.py                              # install the scripts on the Pi
```

Then, on the Pi:

```bash
sudo evcc-psa-token init     # account, country, vehicle, password
sudo evcc-psa-token renew
```

### Configuration

No versioned file holds personal data. Everything installation-specific — Pi
hostname, account email, VIN, device IPs, tokens — lives in **`.env`**, which is
in `.gitignore`. [`.env.example`](.env.example) documents every variable.

It is read by `setup-pi.py`, `deploy.py` and `evcc-fix.py`; values can also come
from the environment (`EV_VIN=VF3… sudo -E python3 setup-pi.py evcc`). Without a
`.env` the scripts fall back to neutral values and the generated `evcc.yaml`
carries `FILL-IN-…` placeholders where input is needed.

The MyPeugeot password is the exception: it never touches the repository — it
lives on the Pi in `/etc/evcc-psa-token.conf` (0600, root), written by
`evcc-psa-token init`.

## setup-pi.py

Post-install configuration of the evcc image, in idempotent sections: `system`,
`pihole`, `caddy`, `dns`, `tailscale`, `wifi`, `evcc`, `hostname`, `summary`.
Generates `/etc/evcc.yaml` from `.env`.

```bash
sudo python3 setup-pi.py            # everything, in order
sudo python3 setup-pi.py caddy dns  # only some sections
sudo python3 setup-pi.py --dry-run  # show what it would do, do nothing
python3 setup-pi.py --list
```

## Where things live

| where                           | what                                             |
| ------------------------------- | ------------------------------------------------ |
| `/usr/local/bin/evcc-psa-token` | the tool (Python 3, stdlib only), runs as root   |
| `/etc/evcc-psa-token.conf`      | account + MyPeugeot password (0600, root only)   |
| `/etc/evcc.yaml`                | where the tokens get written                     |
| `/var/backups/evcc.yaml.bak`    | backup of the last run (overwritten each time)   |
| `evcc-psa-token.timer`          | daily check, if `install-timer` was run           |
| `/usr/local/bin/evcc-watch`     | watches the EMMA and the OCPP session (1 min timer) |

That is all — nothing else is installed on the Pi.

## Commands

```bash
sudo evcc-psa-token init            # set up account and password
sudo evcc-psa-token status          # is the token alive? (changes nothing)
sudo evcc-psa-token renew           # always renew
sudo evcc-psa-token check           # renew only if actually broken
sudo evcc-psa-token install-timer   # daily automatic check + on boot
```

Options: `--country XX`, `--dry-run` (prints the tokens, writes nothing),
`--no-restart`, `-v`.

### From the Mac

```bash
./evcc-fix.py            # token status
./evcc-fix.py renew      # renew
./evcc-fix.py --watch    # latest evcc-watch messages
./deploy.py              # push changes to the Pi
./deploy.py --setup dns  # run setup-pi.py sections on the Pi
```

## What `renew` does

1. headless login through stelloauth (`POST /oauth`) → OAuth code
2. exchanges the code at `idpcvs.peugeot.com/am/oauth2/access_token`, **with the
   same `client_id` evcc uses to renew**
3. writes `accessToken`/`refreshToken` into the vehicle's block in `evcc.yaml`
   (backup first; only those two lines change, comments untouched)
4. stops evcc, deletes the `psa.peugeot.<email>` key from the database
   (`/var/lib/evcc/evcc.db`) — otherwise the token stored there overrides the
   one in the yaml — and starts evcc again
5. confirms against the Stellantis API and lists the account's vehicles

## How `status`/`check` decide

They probe the access token with a `GET /user/vehicles` against the Stellantis
API, without consuming or rotating the refresh token. But **a 401 does not mean
something is broken**: the access token lasts ~1 h and evcc renews it on demand.

The reliable signal is in evcc's `identity.go` — when the refresh fails with
`invalid_grant`, it **deletes** the `psa.<brand>.<email>` key from the database:

| key in the database | probe | verdict |
| ------------------- | ----- | ------- |
| present             | 200   | fine |
| present             | 401   | fine — access token expired, evcc renews it itself |
| missing             | 200   | fine — fresh install, no refresh yet |
| missing             | 401   | **broken** — evcc gave up, the login has to be repeated |

Treating 401 as a failure made the timer run a full renewal every single day for
no reason — and every renewal sends the account password to the login service.

## NucBox: dev server

`nucbox/` records a second machine, unrelated to the Pi: an Ubuntu x86_64 box that runs
[Orca](https://onorca.dev)'s headless runtime and the [Everon](#everon-on-the-box) viewer behind
its own Caddy, plus its own clones of `~/projects` and the dogchef `dev` stack in an LXD container. That Caddy is not the Pi's (`setup-pi.py`: internal
CA, evcc/Pi-hole/Cockpit): it gets public certificates for a wildcard through Cloudflare's DNS
challenge and puts a login page in front of Everon. Values come from the same `.env` (`NUCBOX`,
`CADDY_DOMAIN`, `PREVIEW_DOMAIN`, `ORCA_HOST`, `ORCA_PORT`, `EVERON_HOST`, `EVERON_USER`, `LAN_CIDR`; see
`.env.example`).

```bash
./nucbox/push.sh                  # Mac: copy nucbox/ to ~/nucbox on the box, with only those variables
# then on the box, in ~/nucbox:
./caddy-install.sh                # Caddy modules, environment file, service drop-in, baseline Caddyfile
./install-orca.sh [orca.deb]      # installs orca-ide from the .deb if missing; renders orca.service, linger, starts it
./caddy-orca.sh                   # adds the @orca site to the live Caddyfile (--print: render only)
./caddy-everon-login.sh           # adds the login-protected @everon site (--print: render only)
./caddy-previews.sh               # https://<port>.PREVIEW_DOMAIN -> 127.0.0.1:<port>, tailnet + LAN, shared login
./caddy-previews.sh --rotate-key  # new previews key: ends every preview session (Everon's stay)
./orca-tailnet-block.sh           # drops ORCA_PORT arriving on tailscale0
./dev-lan-access.sh               # LXD dev: firewall, key-only sshd, dev-proxy on its LAN address (no sudo)
./pihole-test-dns.sh              # Pi-hole answers *.test with LXD dev's address
./pihole-dev-dns.sh               # Pi-hole answers *.PREVIEW_DOMAIN with the box's LAN address
```

### Caddy

- Built from the distribution's `caddy` package (2.6.2 on Ubuntu 26.04) with
  `caddy add-package github.com/caddy-dns/cloudflare github.com/greenpau/caddy-security`. Measured:
  Caddy v2.11.7, `dns.providers.cloudflare` v0.2.4, `security` (caddy-security) v1.4.1. On the box
  `dpkg-divert --list` shows `/usr/bin/caddy` diverted to `caddy.default` (the stock binary) and
  `update-alternatives` points `/usr/bin/caddy` at `caddy.custom` (priority 50 over 10), so an apt
  upgrade replaces only the stock one. `add-package` rewrites the file `/usr/bin/caddy` resolves to, so
  `caddy-install.sh` copies the stock binary to `caddy.custom` and points the alternative at it first
  (stubbed dry run only, untested on a fresh box)
  and refuses to touch a live Caddyfile that is not the package default.
- `/etc/caddy/cloudflare.env` (root, 0600; shape in `cloudflare.env.example`) holds
  `CLOUDFLARE_API_TOKEN` (Zone:DNS:Edit), `AUTHP_SHARED_KEY` and `AUTHP_PREVIEW_KEY` (random, sign the
  Everon login's and the previews' login's tokens; `caddy-install.sh` generates both). `caddy-cloudflare.conf` is the drop-in
  (`/etc/systemd/system/caddy.service.d/cloudflare.conf`) that loads it into `caddy.service`.
  Fill the token with `sudoedit`; none of the values is ever copied elsewhere.
- Shape of the Caddyfile (`Caddyfile.template`): global `acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}`,
  one `*.CADDY_DOMAIN` site with a `@name host ...` matcher and `handle @name { ... }` per service, and
  a catch-all `handle { respond ... 404 }` last. `caddy-install.sh` replaces the whole file, only
  when it is the package default (it refuses otherwise); the other `caddy-*.sh` scripts only touch their
  own matcher and handle, or their own site block for the previews, plus (for the login) the global
  `security` block (`security_block` in `caddy-lib.sh`), so
  other sites stay as they are.
- Every script validates as the `caddy` user with the service's environment loaded (`setpriv`; a plain
  `caddy validate` as root misses the env and the `caddy` user's permissions), keeps
  one `Caddyfile.bak`, restarts, and rolls back if Caddy does not come up. An unchanged Caddyfile
  (after `caddy fmt`) exits without a restart.
- Measured: caddy-security's store `/var/lib/caddy/authcrunch` must be owned by `caddy`;
  root-owned files there stop the service (`lstat` permission denied).
- Sites are open to the tailnet (`TAILNET_CIDR`, default `100.64.0.0/10`) and `LAN_CIDR` only; anyone
  else gets a 403 from Caddy.

### Everon on the box

Install it as the slack repo's `electron/README.md` says (`sudo timedatectl set-timezone <zone>`, then
`EVERON_KEYBOARD=<layout> make app`). `caddy-everon-login.sh` is the login in front of its noVNC viewer
(unix sockets `/run/everon/novnc.sock`, and `novnc-pc.sock` for a PC keyboard, which only `everon` and
Caddy can open; there is no TCP port): a caddy-security local identity store with one user,
`EVERON_USER`. The password is asked once (`caddy hash-password`) and afterwards kept as it is in the
Caddyfile; no hash lives in this repo. The page at `/` opens the viewer with `path=websockify` on Apple
platforms and `websockify-pc` elsewhere, and noVNC's Disconnect button keeps noVNC's own "Disconnecting..." screen up while it calls `/auth/logout` with a background `fetch` (so text typed in the address bar does not block it); once the logout answers with its redirect it goes to the login after 300 ms, and on any failure it navigates to `/auth/logout`. If the browser blocks either navigation, after 2 s that screen shows a link to finish by hand ("Entrar novamente" or "Terminar sessão").
A page restored from the browser's back-forward cache reloads itself (so it goes through the login). When noVNC drops without the Disconnect button (Caddy restart, network), the page checks the session: gone, it goes to the login; still valid, it reloads the viewer, up to 3 tries 3 s apart (the count resets on a successful connect), after which noVNC's disconnected screen stays. A tab hidden for 5 minutes logs out and drops its viewer (the iframe is blanked, `/auth/logout` is called as the Disconnect button does) and goes to the login when visible again: wayvnc 0.9.1 lets only one client control the output's power, so a forgotten viewer starves the others of frames (grey screen; fixed upstream in 197b87e / 0.10.1, Ubuntu 26.10).

Alerts: set Everon's `alertUrl` to `https://<ha-host>/api/webhook/<webhook_id>` and add
`ha-everon-alert.yaml` to Home Assistant (webhook trigger, `notify.send_message` to your phone). The
HA companion app needs its notification permission in the phone's settings, not only inside the app,
for the message to reach the notification centre.

### Previews of local dev servers

Any dev server on the box opens at `https://<port>.PREVIEW_DOMAIN` (e.g. `https://4321.dev.example.com`) from
the tailnet and the LAN, after one shared login, for ports 3000-9999 except the denylist: start it on `127.0.0.1:<port>`
or `[::1]:<port>` (Caddy tries `127.0.0.1` first and `[::1]` when nothing listens there) and open the URL.
`caddy-previews.sh` adds the `*.PREVIEW_DOMAIN` site. The dogchef `.test` apps are a separate
path ([below](#dogchef-dev-stack-in-lxd): they live in the container `dev`, not on `127.0.0.1` here).

- Who gets in: Caddy answers 403 to any source outside `TAILNET_CIDR` and `LAN_CIDR`; everyone else
  goes through the login at `https://login.PREVIEW_DOMAIN/` (the Everon user, `EVERON_USER`). One login opens
  every preview for 30 days, and the cookie lasts as long, so closing the browser keeps it (Everon's is 12 h);
  logout: `https://login.PREVIEW_DOMAIN/logout`.
  The previews' portal signs with its own key (`AUTHP_PREVIEW_KEY`) and sets its cookie for
  `PREVIEW_DOMAIN` only, never the parent domain: every dev server sees that cookie, and a token it copies
  is not valid on Everon (and Everon's is not valid here). Orca and Everon stay on `CADDY_DOMAIN`.
- The catch: a token is a signed bearer token checked only against the key. Code running in any dev server
  (your own, or a bad npm dependency) receives it and, from the tailnet or the LAN, can replay it on every
  other preview until it expires, up to 30 days. Logout only deletes the cookie in your browser; a copied
  token stays valid. The only way to end every session at once is `./caddy-previews.sh --rotate-key`
  (sudo): it writes a new random `AUTHP_PREVIEW_KEY` into `/etc/caddy/cloudflare.env` (old file kept as
  `cloudflare.env.bak`, root, 0600; no key is printed), validates, restarts Caddy and restores the old file
  if Caddy does not come up. Every preview needs the login again; Everon's sessions stay. Rotate after running
  code you do not trust in a dev server, after a device that was logged in is lost or shared, and when a
  session should not outlive its use. It is manual, there is no timer.
- Names: `pihole-dev-dns.sh` (sudo) adds `address=/PREVIEW_DOMAIN/<the box's LAN address>` to Pi-hole, like
  `CADDY_DOMAIN`. Tailnet devices reach it through the split DNS route `PREVIEW_DOMAIN` -> the box's
  tailnet address (Tailscale admin console) and the box's subnet route for `LAN_CIDR`. No public DNS record.
- Bind to `127.0.0.1` or `::1`, not `0.0.0.0`: tailscale accepts tailnet traffic before ufw (see Orca), so a
  server on `0.0.0.0` is open to the tailnet and the LAN directly, on any port, denylist or not.
- Caddy rewrites `Host` to `localhost:<port>`: Vite (`server.allowedHosts`) and webpack-dev-server
  (`allowedHosts`) refuse other hosts, `localhost` passes; `X-Forwarded-Host` keeps the real name.
  A server that builds absolute URLs from `Host` (redirects) points at `localhost:<port>`; set its
  public URL to the preview's. Websockets (HMR) pass through.
- Certificate: one `*.PREVIEW_DOMAIN` certificate through the same Cloudflare DNS challenge. With
  `PREVIEW_DOMAIN` in the same Cloudflare zone as `CADDY_DOMAIN` (e.g. `dev.example.com` and `casa.example.com`, both
  under the zone `example.com`: `dig SOA <name>` shows it), the token that got `*.CADDY_DOMAIN` covers it (Cloudflare token permissions are
  per zone).
- Refused with a 404: any label that is not a port in 3000-9999 (`abc`, `2999`, `10000`,
  `04321`) and the denylist (`DENY` in `caddy-previews.sh`), ports that are never a dev server:

  | Port | What | Source |
  |---|---|---|
  | 3000 | stellantis-worker (uvicorn, podman with host network, root) | `ps`: `uvicorn main:app --port 3000`; `stellantis-worker.container` |
  | 3306 | MySQL (dogchef `dev-mysql`, in the container) | well-known; `docker-proxy` in LXD dev |
  | 5252 | Tailscale web client (off now) | `tailscale debug prefs`: `RunWebClient false` |
  | 5900 | VNC/SPICE of the `haos` VM when libvirt gives it a display (first autoport) | libvirt default; `haos.xml` needs sudo |
  | 6379 | Redis (dogchef, in the container) | well-known; `docker-proxy` in LXD dev |
  | 6768 | Orca runtime (`0.0.0.0`) | `ss -ltnp`: `orca-ide` |
  | 7070 | evcc's default UI port | well-known (evcc runs in the HA VM / on the Pi) |
  | 8080 | Pi-hole web admin (`127.0.0.1`) | `curl`: `302 /admin/login`; `PIHOLE_WEB_PORT_HTTP` |
  | 8123 | Home Assistant's well-known port; in the `haos` VM it serves on port 80 | probe 2026-10-23: 192.168.68.53 port 80 open, 8123 closed |
  | 8443 | Pi-hole HTTPS admin / LXD API (both off now) | `PIHOLE_WEB_PORT_HTTPS`; `lxc config get core.https_address` empty |
  | 8887 | OCPP from the wallbox, DNATed to the HA VM | `/etc/nucbox-nat.nft` |
  | 9090 | Cockpit | `systemctl list-sockets`: `cockpit.socket` |

  A new service on the box in that range: add its port to `DENY`, then `./caddy-previews.sh`.
- Check (no sudo, the box's caddy): `node --test nucbox/tests/previews.test.mjs` runs Caddy as you on a
  high port with the rendered config (over the Everon render) and test upstreams, logs in through both
  portals and checks that their tokens do not cross; `node --test nucbox/tests/pihole-dns.test.mjs`
  runs `pihole-dev-dns.sh` against stubs.
- Undo: `sudo cp -p /etc/caddy/Caddyfile.bak /etc/caddy/Caddyfile && sudo systemctl restart caddy`
  (right after the run), or delete the `*.PREVIEW_DOMAIN { ... }` block by hand and restart; Pi-hole:
  remove the `address=/PREVIEW_DOMAIN/...` line (`sudo pihole-FTL --config misc.dnsmasq_lines '[...]'`).

### Orca

- Download the `orca-ide` amd64 `.deb` from the project's releases (github.com/stablyai/orca) and run
  `./install-orca.sh orca.deb`: it installs the package (running the extracted app fails, its
  `chrome-sandbox` is not setuid) and the user unit for the current user, with linger on so it runs
  without a login. Tested with 1.4.224.
- **Pairing URL** is a secret; read it on the box and never commit it:
  `journalctl --user -u orca -o cat | grep "Pairing URL"`.
- **Measured: orcad is broken** in orca-ide 1.4.224 (missing module), so `serve` falls back
  to Electron, which works headless. It binds `0.0.0.0` and has no bind option.
- **Measured: tailscale comes before ufw.** Its `ts-input` chain is jumped first in `INPUT`
  and accepts everything on `tailscale0`, so `ufw deny in on tailscale0` does nothing (the port
  still answered over the tailnet). `orca-tailnet-block.sh` drops the port in the raw table from
  `/etc/ufw/before.init` (marked `orca-tailnet` section; other content is kept, a non-shell file is
  refused), which ufw runs on `start`/`stop`/`flush-all`. A `*raw` block in `before.rules` is not
  used: `ufw reload` re-applies those files without flushing, so it added one more copy per reload.
  The script also removes an older block from `before.rules`/`before6.rules` and duplicate live
  rules, then prints the raw table (one rule each). Afterwards tailnet and LAN get no answer on the
  port and Caddy still does.
- Changing `ORCA_PORT` later: no hand edit needed, the script replaces its `orca-tailnet` section (BEGIN/END markers). The old port's live raw rule stays until a reboot, or run `sudo /etc/ufw/before.init stop` before the change (harmless).

### Claude Code and GitHub on the box

Claude Code is the only agent. Install it with the official installer (`curl -fsSL https://claude.ai/install.sh | bash`,
it lands in `~/.local/bin/claude`, which the Orca unit has on its `PATH`) and log in yourself
(`claude auth login`). For GitHub, make a key on the box (`ssh-keygen -t ed25519`), add the public key
to your account, and check it with `ssh -T git@github.com`. Clones with an `https://` remote need
`gh auth setup-git` once (after `gh auth login`); without it `git push` fails with "unable to get
password from user".

### Claude business account for dogchef

`bash nucbox/claude-business.sh` makes Claude Code use the business account in dogchef and the personal one
everywhere else. The rule is the wrapper `nucbox/claude-wrap`, installed as `~/.local/claude-wrap/claude` and put
first on PATH (a line in `~/.bashrc` for interactive shells, a marked block at the end of `~/.profile` because non-interactive login shells skip `~/.bashrc` and `~/.profile` itself prepends `~/.local/bin`, which Orca's agents inherit, and in `orca.service`): when `CLAUDE_CONFIG_DIR` is not set and the directory is under
`~/projects/dogchef` or a git repo whose `origin` is in `dogchef-be/` (so Orca worktrees too), it sets
`CLAUDE_CONFIG_DIR=~/.claude-business`, then execs the real `~/.local/bin/claude`. The script also creates
`~/.claude-business` with `CLAUDE.md`, `settings.json`, `skills` and `plugins` symlinked to `~/.claude` (an existing
real file there is left alone) and cleans the old direnv setup (the hook line in `~/.bashrc`, the export in
`~/projects/dogchef/.envrc`, the file itself if nothing else is in it; the `direnv` package stays, remove it with
`sudo apt remove direnv`). Safe to run again. Then, in a new shell, `cd ~/projects/dogchef/dev && claude`, `/login`
with the business account, `/status` to confirm. Orca only gets the wrapper after its unit is re-rendered and
restarted (ends running agents): `bash nucbox/install-orca.sh && systemctl --user restart orca.service`. Undo: remove
the PATH line in `~/.bashrc`, the marked block in `~/.profile`, `~/.local/claude-wrap`, `~/.claude-business`, the
`UserPromptSubmit` entry whose command is `CLAUDE_WRAP_HOOK=1 ~/.local/claude-wrap/claude` in `~/.claude/settings.json`
(the first run saved `settings.json.bak-claude-business` next to it), and re-render the unit.

Account guard: a `UserPromptSubmit` hook (the wrapper itself run with `CLAUDE_WRAP_HOOK=1`, which never starts claude; needs `jq`)
applies the wrapper's own rule to the session's `cwd`. When the session's account
(`CLAUDE_CONFIG_DIR` pointing at `~/.claude-business`, or unset/`~/.claude`) is not the one expected, it blocks the prompt
with a message; exit and start `claude` from a bash terminal in that folder. Any internal error lets the prompt through.
Bypass: `CLAUDE_WRAP_GUARD=0 claude` keeps the personal account in any folder and the hook, which inherits the
variable, lets every prompt through, even for a business session (preset `CLAUDE_CONFIG_DIR`) in a personal folder.
Children inherit it on purpose: every agent or `claude` the bypassed session launches runs unguarded too. Set it only
by starting a session with it, never from a profile, bashrc or unit; it is read when the session starts, so turning it
on or off means a new session (or a resume). Do not export `CLAUDE_WRAP_GUARD=1` by hand: hook mode is `CLAUDE_WRAP_HOOK=1`.
The hook used to be `CLAUDE_WRAP_GUARD=1 …`; a re-run of the script replaces that entry, and the wrapper still treats the
old name as the hook for sessions started before, which keep the hooks they started with.
Tests: `node --test nucbox/tests/claude-business.test.mjs nucbox/tests/claude-wrap.test.mjs nucbox/tests/claude-guard.test.mjs`.

### Projects on the box

The box keeps its own clones under `~/projects/<org>/` and works on them itself; code moves
between the Mac and the box through GitHub (push on one side, pull on the other), never by copying
folders, which would overwrite unpushed work. Files outside git (`.env`, `dev/.config`) are copied
by hand when they change.

### dogchef `dev` stack in LXD

The `dev` repo's compose binds `127.0.0.1:80/443`, which the box's Caddy already holds on every
address, and the repo is shared, so it runs unchanged in an LXD system container `dev` with its own
Docker and its own LAN address. Everything dogchef (repos of the `dogchef-be` org) goes through
`dogchefbox`; nothing of it runs on the host. The apps open inside the box and, through the NucBox only,
from the Mac ([below](#dogchef-apps-and-db-from-the-mac)).

```bash
lxd init --preseed <<'EOF'          # dir pool, no managed network (no lxdbr0, whose dnsmasq would want :53)
storage_pools: [{name: default, driver: dir}]
profiles: [{name: default, devices: {root: {path: /, pool: default, type: disk}}}]
EOF
lxc init ubuntu:26.04 dev -c security.nesting=true -c limits.cpu=10 -c limits.memory=16GiB -c boot.autostart=true
lxc config device add dev eth0 nic nictype=bridged parent=br0 name=eth0
lxc start dev && lxc exec dev -- cloud-init status --wait
lxc exec dev -- bash -c 'usermod -l fabio -d /home/fabio -m ubuntu && groupmod -n fabio ubuntu'
nucbox/lxd-dev-mounts.sh            # the dogchef disks, see below
lxc exec dev -- bash -c 'apt-get install -y docker.io docker-compose-v2 git make curl && usermod -aG docker fabio'
install -m 755 nucbox/box ~/.local/claude-wrap/box && ln -sfn ~/.local/claude-wrap/box ~/.local/bin/dogchefbox
# the rule for Claude Code (Orca) is nucbox/claude-devbox.md, kept in ~/.claude/CLAUDE.md (rename-projects.sh swaps the old block for it)
cd ~/projects/dogchef/dev && dogchefbox make setup && dogchefbox make start
```

- `lxd-dev-mounts.sh` (lxc only, safe to run again, works on a stopped container) gives `dev` one disk per dogchef
  folder, same path inside: `~/projects/dogchef` (`m-p-dogchef`) and each `~/orca/workspaces/*` whose worktrees are
  dogchef (`m-o-<workspace>`, `is-business-dir.sh`; the rule `lxd-personal.sh` inverts). It removes the old whole-tree
  `projects` and `orca` disks and stale `m-*` ones, and never touches `personal`. **Re-run it after creating a dogchef
  Orca workspace.** On a stopped container it prints the `install -d` for the mount parents to run after `lxc start`.
- Create the user before adding the disks: the mount creates `/home/fabio` as root and
  `usermod -m` then fails. Copy `~/.gitconfig`, the GitHub key and its `known_hosts` lines into the
  container's home; the mkcert CA comes from the Mac's `dev/.config/mkcert`.
- `dogchefbox` uses `lxc exec`, not ssh. The container's sshd (key-only) and dev-proxy's LAN ports exist
  for the Mac and are reachable from the NucBox's address only (`dev-lan-access.sh`, below).
- `dogchefbox` (`lxc exec … sudo -u fabio -H bash -l`) runs in the current directory as fabio with the
  `docker` group, and refuses a folder that is not dogchef (exit 2, `is-business-dir.sh`, the rule `claude-wrap` uses); `lxc exec --user` alone gives gid 0 and no supplementary groups.
- `br0` traffic does not go through ufw only because `br_netfilter` is not loaded
  (`lsmod | grep br_netfilter` empty). Loaded later, it would cut the container and the `haos` VM off;
  `/etc/sysctl.d/99-br0.conf` sets `net.bridge.bridge-nf-call-ip{,6}tables=0` at boot, and an
  `install br_netfilter` line in `/etc/modprobe.d/br0.conf` applies it whenever the module is loaded
  later (Ubuntu ships no udev rule for that, and the keys do not exist until the module is in).
- Inside the container `*.test` is the stack's own dnsmasq (127.0.0.1). The host's glibc asks
  Pi-hole and never reads systemd-resolved (`hosts: files mymachines dns`, stub listener off), so on
  the host and the Mac `*.test` is Pi-hole's answer: the container's LAN address (`pihole-test-dns.sh`).
- The dev DB cluster is private AWS (172.31.x), reached through Cloudflare WARP, org `dogchef`,
  installed and registered inside the container only (`pkg.cloudflareclient.com`, then
  `warp-cli registration new dogchef`). The login token from `https://dogchef.cloudflareaccess.com/warp`
  lasts about a minute: copy the "Open Cloudflare WARP" link instead of clicking it (the Mac's own
  WARP would take it) and pass it to `warp-cli registration token "<link>"`, then `warp-cli connect`.
  `make reset-db-{dogchef,vetchef,erp}` needs it.
- After a reboot the container comes back but the stack does not (no restart policy in the compose):
  `cd ~/projects/dogchef/dev && dogchefbox make start`.
- The `dev` repo's MCP servers run on the host with Claude Code: `uv`, the AWS CLI and the Google Cloud
  SDK live under `~/.local` and `~/google-cloud-sdk` (no sudo), `~/.bashrc` exports
  `GITHUB_PERSONAL_ACCESS_TOKEN` from `gh auth token`, and the AWS/gcloud logins are yours.

### Renaming `~/Projects` to `~/projects` (window script)

`nucbox/rename-projects.sh` is the one-time window: the rename and the devbox/dogchefbox switch-over together. Close every Claude
session and the Orca app, open a plain terminal (ssh or tty, not Orca, not Claude, cwd outside `~/Projects`) and run
`bash nucbox/rename-projects.sh --dry-run --slot <tree>...` first (prints every action, changes nothing), then without `--dry-run`.
`--slot <worktree>` (repeatable) names the dev worktrees whose `dev-apps` replica is recreated after the restart, `--no-slots` says
none. The window takes the dev stack and both containers down for about half an hour. Steps, each verified, the first failure stops
with its rollback: stop Orca; back up to `~/backup-projects-rename` (a fixed name: a re-run on another day reuses it; json, histories, wrapper dir, Orca DB, `lxc config show`,
git links before-state, docker volumes and their mounts, open factory `task.md` files); stop the stack and containers; `mv` + the compat symlink `~/Projects -> projects`; rewrite the git worktree
links; Claude state (project dirs, json paths, history `project` fields); install box and wrapper; LXD disks (`dev` dogchef only, `personal`
the rest); restart, `dogchefbox make start` and the slots (named volumes kept and checked: the same containers must mount the same volumes); the `~/.claude/CLAUDE.md` block from
`claude-devbox.md`; handoffs `devbox` -> `dogchefbox`; the `Folder:` line of open factory records under `~/.factory/tasks`; `devbox` -> box; the Orca registry (payload and its sha256 `content_hash`).
A re-run continues where it stopped.

Whole rollback: stop sessions, Orca and containers; `rm ~/Projects && mv ~/projects ~/Projects`; restore the files from the backup
folder (`cp -a` keeps the full paths); sed the git links back from `git-links.tsv`; rename the `-home-fabio-projects-*` Claude dirs back;
`lxc config device` back from `lxc-dev.txt` / `lxc-personal.txt`; `dogchefbox make start` from the old path. After a week, with nothing
naming it, `rm ~/Projects` (the symlink). Test: `node --test nucbox/tests/rename-projects.test.mjs`.

### Personal container `personal` (LXD)

`devbox` runs in the LXD container `personal`, on its own NAT bridge `lxdpersonal0` (10.250.50.0/24): no LAN or
tailnet address, no DHCP. Its dev servers reach the host's 127.0.0.1 only through LXD proxy devices (3010 5000 8000
8010 8026 8125 9001, plus the container's 3000 as 3100 because the host's stellantis-worker holds 3000).

```bash
./lxd-personal.sh     # no sudo, only lxc; safe to run again; env PERSONAL_* override names, sizes, ports, DNS
lxc delete -f personal && lxc network delete lxdpersonal0     # undo; the mounted folders are untouched
```

- LXD's `dns.mode=none` still starts its dnsmasq with DNS on, which dies on Pi-hole's `:53`; the bridge therefore
  sets `raw.dnsmasq=port=0`, and the container gets a static address and the host's Pi-hole (192.168.68.50, `PERSONAL_DNS`) as its only resolver,
  no public fallback, through cloud-init.
- No dogchef files inside: instead of mounting all of `~/projects` and `~/orca`, the script adds one disk (`m-p-<dir>`,
  `m-o-<workspace>`, same paths, `shift=true`) per `~/projects/*` except dogchef and per `~/orca/workspaces/*` whose
  worktrees are not dogchef (`is-business-dir.sh`; an empty workspace counts as personal). A re-run adds disks for
  new dirs and removes stale `m-*` ones, so **re-run the script after creating an Orca workspace or a projects folder**.
- Run it from `nucbox/` (`cd ~/projects/personal/evcc-pi/nucbox`).
- The scripts take the projects folder from `PROJECTS_DIR` (default `~/projects`, or `~/Projects` while only that exists, i.e. until the rename; set in `is-business-dir.sh`, which `claude-business.sh` and `dev-lan-access.sh` source). `is_business_dir` compares physical paths, so the `~/Projects` compat symlink still counts.
- Probed on this host: ufw is active (`/etc/default/ufw`: input and forward default DROP), so with no rule for
  `lxdpersonal0` TCP/UDP to the host (Pi-hole `:53`, DHCP) and forwarded to the internet are dropped while ICMP
  passes. The script then stops after creating the container, before provisioning, when it has no TCP egress or
  cannot resolve a name, and prints `sudo ufw status verbose` (fallback `sudo nft list ruleset`). The two ufw
  rules that open it are not applied by the script (root):

```bash
sudo ufw route allow in on lxdpersonal0 out on br0 from 10.250.50.0/24 comment 'LXD personal -> internet (LAN/tailnet blocked by LXD ACL)'
sudo ufw allow in on lxdpersonal0 to 192.168.68.50 port 53 comment 'LXD personal -> Pi-hole DNS'     # INPUT to the Pi-hole
```

- The host's ufw rules (from the audit of `ufw status numbered`, 2026-10-23; default input and forward DROP):

| Rule | Why |
|---|---|
| SSH from the LAN | remote login |
| Caddy ports from the LAN | the box's Caddy (Everon, previews) |
| 3000 from 192.168.68.53 | one LAN client (the Mac) to the host's stellantis-worker |
| 53 from the LAN | Pi-hole |
| `tailscale0` in (v4 and v6) | tailnet clients reach the host |
| `tailscale0` forward to `br0` (v4 and v6) | the subnet router: tailnet to the LAN and `dev` |
| 8887 forward to 192.168.68.53 | DNAT target of the port-8887 forward |
| `allow in on lxdpersonal0 to 192.168.68.50 port 53 comment 'LXD personal -> Pi-hole DNS'` | `personal` resolves through Pi-hole |
| `route allow in on lxdpersonal0 out on br0 from 10.250.50.0/24 comment 'LXD personal -> internet (LAN/tailnet blocked by LXD ACL)'` | `personal` reaches the internet; the LAN and tailnet are blocked by the LXD ACL below, not by ufw |

- ufw has no deny for the LAN: a `route deny ... to 192.168.68.0/22` was applied first and deleted by the user
  (`sudo ufw route delete deny in on lxdpersonal0 to 192.168.68.0/22`) once the ACL below was confirmed live. The ACL is
  the only block for the LAN and the tailnet.

- There is no ufw rule for the tailnet: tailscale's `ts-forward` chain is jumped before ufw in `FORWARD`
  and accepts everything out of `tailscale0` (same cause as "tailscale comes before ufw" above), so no ufw rule can
  block it; measured: `100.100.100.100:53` and a peer's ping were open from the container. The script therefore also
  creates an LXD network ACL `personal-egress` on `lxdpersonal0` (nftables driver, no sudo; default egress allow) and
  replaces its rules on every run (`lxc network acl edit`), so an ACL left empty by an interrupted run is repaired:
  drop to 192.168.68.0/22 and 100.64.0.0/10, except 192.168.68.50, where tcp and udp ports other than 53 and icmp4 are
  dropped by their own rules (an ACL drop beats an allow, so the range skips the Pi-hole instead of allowing it;
  `PERSONAL_LAN_DROP` changes it together with `PERSONAL_DNS`). LXD ACLs cannot express "every protocol except port
  53", so other IP protocols (sctp, gre, ...) to 192.168.68.50 are not dropped. With it the tailnet, the LAN and the
  Pi-hole's other tcp/udp ports and pings are blocked and DNS plus the internet work. Undo with the network delete above, then
  `lxc network acl delete personal-egress`.
- Provisioning follows `dev`: php 8.4 from the sury repo (football-fines pins 8.4.x; Ubuntu's own composer package
  would pull php 8.5, so composer is the official installer, verified against composer.github.io/installer.sig, in `/usr/local/bin`), docker.io + compose, node 24 from
  NodeSource, python3-venv, corepack. Any failing step stops the script, which prints `ready` only when
  `php` 8.4, `composer`, `docker ps`, `node` and `python3` work for `fabio` (docker group).

### dogchef apps and DB from the Mac

The apps open by their own `https://<app>.test` names (they call each other by those names, e.g.
`APP_URL=https://backend.test`), and the dev MySQL through an SSH tunnel. Not the same guard as
Everon: the LAN is shut out except the NucBox itself, and the key covers only ssh and the DB. The web
apps have no login in front of them; they rely on the Tailscale ACL below and on the apps' own login.

```bash
./dev-lan-access.sh     # on the box, no sudo (lxc exec): container firewall, sshd, dev-proxy on the LAN address
./pihole-test-dns.sh    # on the box, sudo: Pi-hole answers *.test with the container's address
```

- **Path**: Mac → tailnet (split DNS `test` → the NucBox's Pi-hole, set in the Tailscale admin) →
  the NucBox as subnet router, which SNATs tailnet clients to its own LAN address
  (`tailscale debug prefs`: `"NoSNAT": false`) → the container's `eth0`.
- **Firewall** (inside the container): table `inet dev_lan`, hook prerouting at priority -150, accepts
  tcp 22/80/443 on `eth0` from the NucBox's address and drops them from anything else (IPv6 included).
  Prerouting, because Docker DNATs its published ports there and they never reach an input chain. Its
  own unit `dev-lan-filter.service` (enabled, before `network-pre.target`) loads
  `/etc/nftables-dev-lan.nft`; the stock `nftables.service` stays off because its stop flushes the
  whole ruleset, Docker's and WARP's included. Measured: from a throwaway LXD container on `br0`
  80/443/22 time out and the drop counter rises, while the box gets through.
- **dev-proxy** keeps `127.0.0.1:80/443` and also publishes on the container's LAN address, from
  `docker-compose.override.yml` in the `dev` repo: written by the script, listed in the repo's
  `.git/info/exclude`, never committed, and read by `make start` (compose loads an override next to
  `docker-compose.yml` by itself). MySQL and Redis stay on 127.0.0.1.
- **sshd** (inside): `/etc/ssh/sshd_config.d/10-dev-lan.conf` (publickey only, no root,
  `AllowUsers fabio`, TCP forwards to `127.0.0.1:3306` only, no socket forwards, no X11),
  `ssh.service` enabled and `ssh.socket` off. The key also gives a shell as fabio, who is in the
  docker group, so whoever holds it is root in the container in effect: the forward limits are only a
  second layer. sshd listens on every address, but the same table drops 22 arriving on any interface
  but `eth0` and `lo` (the Docker bridges, `CloudflareWARP`). The script adds the box's own key (`~/.ssh/id_ed25519.pub`) to the container's
  `~fabio/.ssh/authorized_keys` with `from="<box address>"`; the Mac's key is added from the Mac (below).
- **IPv6**: the drop rule matches no address family, so 22/80/443 over IPv6 time out on any
  address `eth0` has or gets (today only a link-local one).
- **After a reboot** the filter and sshd come up with the container (`boot.autostart`), the LAN ports
  with `dogchefbox make start`, and Pi-hole keeps its line. The container gets its address by DHCP (it was
  `.69` before `.54`): reserve it in the router for its MAC (`lxc config get dev volatile.eth0.hwaddr`).
  If it changes anyway, dev-proxy still starts (`net.ipv4.ip_nonlocal_bind=1` in the container lets it
  bind the old address), but the apps are only reachable from the Mac again after running **both**
  scripts: `dev-lan-access.sh` (new address in the override, filter and key) and `pihole-test-dns.sh`
  (new `*.test` answer).
- **Tailscale ACL**: the subnet route makes the container reachable by every device in the tailnet. If
  the policy still has the default `{"action": "accept", "src": ["*"], "dst": ["*:*"]}`, replace that
  rule with these two (the second is the same reach for everyone else, minus the container's address):

  ```json
  {"action": "accept", "src": ["<your login, e.g. you@github>"], "dst": ["*:*"]},
  {"action": "accept", "src": ["*"], "dst": [
    "autogroup:internet:*", "100.64.0.0/10:*", "fd7a:115c:a1e0::/48:*",
    "192.168.68.0/27:*", "192.168.68.32/28:*", "192.168.68.48/30:*", "192.168.68.52/31:*",
    "192.168.68.55/32:*", "192.168.68.56/29:*", "192.168.68.64/26:*", "192.168.68.128/25:*",
    "192.168.69.0/24:*", "192.168.70.0/23:*"]}
  ```

On the Mac, once:

```bash
# the Mac's key into the container (password login is off)
ssh <nucbox> "lxc exec dev -- sudo -u fabio -H sh -c 'k=\$(cat); grep -qxF \"\$k\" ~/.ssh/authorized_keys || echo \"\$k\" >> ~/.ssh/authorized_keys'" < ~/.ssh/id_ed25519.pub
dig +short backend.test        # with Tailscale on: the container's address
```

Then open `https://<app>.test` and accept the certificate warning (the stack's mkcert CA is not on
the Mac). Do it once per host the page calls too, e.g. open `https://backend.test` directly first:
a page's own calls to another `.test` host fail silently until that host's warning is accepted.
With Cloudflare WARP on, the Mac's DNS skips Pi-hole; turn WARP off or put the hosts in `/etc/hosts`.

The DB:

```bash
ssh -N -L 3306:127.0.0.1:3306 fabio@192.168.68.54   # 13306:127.0.0.1:3306 if the Mac has its own MySQL
```

and point the client at host `127.0.0.1`, port `3306`, user `root`, with the password from the `dev`
repo's `docker-compose.yml` (`MYSQL_ROOT_PASSWORD`).

Rollback, in this order (the LAN ports close before the filter goes, so 80/443 are never open to the LAN):

```bash
cd ~/projects/dogchef/dev && rm docker-compose.override.yml && dogchefbox docker compose -p fresh-chef up -d --no-deps proxy
lxc exec dev -- systemctl disable --now dev-lan-filter.service ssh.service
lxc exec dev -- rm /etc/systemd/system/dev-lan-filter.service /etc/nftables-dev-lan.nft /etc/ssh/sshd_config.d/10-dev-lan.conf /etc/sysctl.d/60-dev-lan.conf
lxc exec dev -- sysctl -w net.ipv4.ip_nonlocal_bind=0
lxc exec dev -- systemctl mask ssh.socket ssh.service
sudo pihole-FTL --config misc.dnsmasq_lines   # then set the list again without the address=/test/ line
```

### Orca clients

Every client pairs with the box itself, using the same pairing URL from the journal: on a computer
(Mac, Windows) Settings → Remote Orca Servers → Add Server; on the iPhone the Orca app takes the
same URL (measured: no `--mobile-pairing` on the unit needed). All of them reach `wss://ORCA_HOST`,
which only Pi-hole resolves, so away from home the client needs the tailnet with Pi-hole as its DNS.

### On the Mac: WARP

With Cloudflare WARP on, the Mac's DNS goes to WARP and ignores the box's names. Put each
`*.CADDY_DOMAIN` host you use (`ORCA_HOST`, `EVERON_HOST`) in `/etc/hosts` pointing at the box's LAN
IP. Tailscale stays on demand: the tailnet addresses are only needed away from home.

## Tuning the control loop

Measured on a Pi 3B+ against a Huawei EMMA, with evcc stopped so the probe
could hold the Modbus connection (register 31657, the one evcc reads for grid
power):

```
45 reads, 36 distinct values
value changes every 2.0 s   (2.0 s was the polling period — the floor was mine)
read latency: min 5 ms | avg 23 ms | max 227 ms
sample: -1075, -1074, -1057, -1111, -1085, -1074, -1063, -1090
```

Two things follow, and the second is the useful one.

**The meter is not the bottleneck.** It refreshes at least every 2 s and
answers in 23 ms, so at a 30 s interval evcc decides on a reading more than
ten generations old. If the meter were the only consideration, a shorter
interval would be obvious.

**But the signal is noisy.** With the house idle the reading swings ~55 W
peak-to-peak. That is measurement, not load.

So: **keep `interval` at 30 s**, because the limit is the wallbox, not the
meter — each cycle can push an OCPP `SetChargingProfile` to a Pulsar that takes
seconds to apply and whose session has dropped more than once. 20 s is as low
as is worth going; not the 10 s the web UI allows.

And **keep `residualPower` at 150-200 W**. The 100 W the UI suggests sits
inside that 55 W noise band, so some corrections would be chasing the meter
rather than the house.

> The EMMA accepts a **single Modbus TCP client** at a time. A second one is
> reset with `connection reset by peer` while the first keeps working — pointing
> Home Assistant at port 502 as well means one of them loses, intermittently.

## evcc-watch

Runs every minute and only speaks up when something changes:

```
OCPP wallbox: DOWN (was up for 20h25m) — no established session on 8887
OCPP wallbox: BACK after 1m01s down (session from 192.0.2.52)
meter (192.0.2.51): DOWN (was up for 3d04h) — icmp no answer, tcp/502 refused
```

Each target gets the check that actually means something: ICMP plus a Modbus
connect for the EMMA; for the wallbox, the presence of the established OCPP
session — since the wallbox is the one dialling evcc, pinging it proves nothing.

```bash
ssh <pi> "sudo journalctl -t evcc-watch -o cat"
```

### Safety net

Off unless `OCPP_RESTART_AFTER` is set in the unit. When it is, evcc gets
restarted if the OCPP session has been missing for that long —
[evcc-io/evcc#27203](https://github.com/evcc-io/evcc/issues/27203) documents
that the connection sometimes only recovers that way. Two guards keep it from
doing harm:

- it only fires **while the wallbox still answers ICMP**. No ping means the box
  is off or off-network, restarting evcc would not bring it back, and we would
  just be restarting a healthy service in a loop.
- at most `OCPP_MAX_RESTARTS` (3) per outage, then it goes quiet and keeps
  warning — a problem that survives three restarts needs a human.

A successful session resets the budget. `evcc-watch --dry-run` shows what it
would do without restarting anything or touching the state file.

```
OCPP wallbox: down for 11m40s while 192.0.2.52 still answers ICMP
              — restarting evcc (attempt 1/3)
OCPP wallbox: down for 11m40s but 192.0.2.52 does not answer ICMP
              — the wallbox is away, not evcc. Not restarting.
```

## Certificate warnings that keep coming back

Caddy's `tls internal` issues leaf certificates that live for **12 hours** by
default. A browser exception is pinned to one specific certificate, so every
time Caddy rotates the leaf the exception stops matching and
`SEC_ERROR_UNKNOWN_ISSUER` comes back.

The fix is in the `(common)` snippet:

```
tls {
  issuer internal {
    lifetime 8760h
    sign_with_root
  }
}
```

`sign_with_root` is not optional here. Without it the leaf is signed by the
intermediate and capped by *its* lifetime — measured on the Pi: 7 days, no
matter what `lifetime` asks for. Signed straight by the root, the cap becomes
the root's own lifetime (ten years) and a full year comes through:

```
notBefore=<issued>    notAfter=<issued + 1 year>
issuer=CN=Caddy Local Authority - <year> ECC Root
```

Changing the config is not enough on its own: Caddy keeps serving the
certificates already in its storage, so a freshly configured year-long
lifetime does nothing until the old ones are gone. `setup-pi.py caddy` handles
that — but only for certificates that actually predate the policy:

```
[+] certificates already issued for ~365 days, leaving them alone
[i] evcc.home.arpa.crt is only valid for 0.5 days, policy asks for 365
    -> backing up and reissuing
```

Wiping the store on every run would mint new certificates each time, and a new
browser warning with them — which is the very thing the long lifetime is meant
to stop. The old certificates are kept in `/var/backups/caddy-certs/` (replaced on each wipe).

One exception per browser per year, instead of two per day. Trusting the root
in each device's OS keychain would remove the warning altogether, at the cost
of one install per device.

## Optional: local helper

If you would rather the password did not go through the third-party site:

```bash
./deploy.py --stelloauth      # install chromium + stelloauth on the Pi
./deploy.py --no-stelloauth   # undo and go back to the public site
```

The installer creates two services: `stelloauth-browser` (the distro chromium,
headless, exposing CDP on `127.0.0.1:9222` — stelloauth does not launch a
browser itself) and `stelloauth` (metrics on `127.0.0.1:8098`, since 9090 is
cockpit's). It points `STELLO_URL` at `http://127.0.0.1:8099`; `--no-stelloauth`
sends it back to the public site and removes the services, the binary and chromium.

Measured cost on a **Pi 3B+ (903 MB RAM)**: ~280 MB of disk for chromium, ~60 s
per login, ~630 MB RAM peak (no OOM, but tight). It works — it is just a lot of
software for something that runs once a month.

## Notes

- **All Python 3, stdlib only** (`urllib`, `json`, `sqlite3`, `tarfile`,
  `hashlib`, `subprocess`) — the Pi has 3.13, macOS has 3.12. Not a single
  shell script in the repository.
- If `STELLO_URL` points at `127.0.0.1` and the service is down, the script
  **fails** instead of falling back to the public service — the password must
  not leave the network by accident.
- The password sits in plain text in `/etc/evcc-psa-token.conf` (0600, root) —
  that is what allows unattended renewal. Leaving `PASSWORD=""` makes the script
  ask every time (but then `install-timer` is pointless).

## Credits and references

This exists because other people did the hard parts first.

**[evcc](https://github.com/evcc-io/evcc)** — the charging controller everything
here serves. Reading its source is what made the token problem solvable:
[`vehicle/psa/oauth2.go`](https://github.com/evcc-io/evcc/blob/master/vehicle/psa/oauth2.go)
is where the single hardcoded `client_id` per brand lives, and
[`vehicle/psa/identity.go`](https://github.com/evcc-io/evcc/blob/master/vehicle/psa/identity.go)
is where it deletes the stored token on `invalid_grant` — the signal `status`
and `check` rely on to tell a stale access token from a broken chain.
[Issue #27203](https://github.com/evcc-io/evcc/issues/27203) documents the OCPP
instability the safety net exists for, and
[`ocpp-wallbox-fw5.yaml`](https://github.com/evcc-io/evcc/blob/master/templates/definition/charger/ocpp-wallbox-fw5.yaml)
is where the `metervalues` fix for "charger out of sync" comes from.

**[tamcore/stelloauth](https://github.com/tamcore/stelloauth)** — the Stellantis
OAuth helper. Gigya requires a CAPTCHA, so a real browser is unavoidable; this
does it in headless Chromium and hands back the code. Itself built on
[benbox69/stellantis-oauth-helper](https://github.com/benbox69/stellantis-oauth-helper).
The public instance used by default is <https://stelloauth.tollet.me>.

**[flobz/psa_car_controller](https://github.com/flobz/psa_car_controller)** —
[discussion #779](https://github.com/flobz/psa_car_controller/discussions/779)
is the reference evcc itself points at for the Stellantis authorisation flow.

**[andreadegiovine/homeassistant-stellantis-vehicles](https://github.com/andreadegiovine/homeassistant-stellantis-vehicles)**
— the Home Assistant integration the OAuth helper was originally written for.

**[Pi-hole](https://pi-hole.net/)**, **[Caddy](https://caddyserver.com/)**,
**[Tailscale](https://tailscale.com/)** and
**[Cockpit](https://cockpit-project.org/)** — DNS filtering with local records,
reverse proxy with its own CA, remote access as a subnet router, and the
system console. `setup-pi.py` wires them together; it did not invent any of them.

**[HaGeZi's DNS blocklists](https://github.com/hagezi/dns-blocklists)** and
**[StevenBlack/hosts](https://github.com/StevenBlack/hosts)** — the blocklists
Pi-hole is seeded with.

Hardware talked to, for the record: a Wallbox Pulsar Plus over OCPP 1.6J, a
Huawei EMMA over Modbus TCP, and a Peugeot e-208 through the Stellantis API.
Nothing here is endorsed by, or affiliated with, any of them.

## License

[MIT](LICENSE). The credited projects above keep their own licences.
