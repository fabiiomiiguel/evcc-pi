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
| `/etc/evcc.yaml.bak-*`          | backups (keeps the last 5)                       |
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
to stop. The old certificates are kept under `/var/backups/caddy-certs/`.

One exception per browser per year, instead of two per day. Trusting the root
in each device's OS keychain would remove the warning altogether, at the cost
of one install per device.

## Optional: local helper

If you would rather the password did not go through the third-party site:

```bash
./deploy.py --stelloauth      # install chromium + stelloauth on the Pi
./deploy.py --no-stelloauth   # undo and go back to the public site
```

The installer points `STELLO_URL` at `http://127.0.0.1:8099`; `--no-stelloauth`
sends it back to the public site and removes the service, the binary and chromium.

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
