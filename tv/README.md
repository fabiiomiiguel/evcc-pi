# tv

Debloat and tidy a Xiaomi Google TV over the network with adb, no root.
Done on a Mi TV MOOR2 (Google TV, Android 11, 1.8 GB RAM, MediaTek M7632) on
2026-10-27. Every removal is reversible with
`adb shell cmd package install-existing <pkg>` or a factory reset.

## Connect

1. TV: Settings → System → About → press "Android TV OS build" 7 times.
2. Developer options → **USB debugging** on. On this TV that alone opens adb on
   port 5555 over the network; wireless debugging was not needed.
3. PC (no adb installed):

   ```
   curl -sSLo pt.zip https://dl.google.com/android/repository/platform-tools-latest-linux.zip
   unzip -q pt.zip && export ADB=$PWD/platform-tools/adb
   $ADB connect <tv-ip>:5555
   ```

4. TV shows "Allow USB debugging?" → **Always allow** → OK.

## Run

```
tv/debloat.sh <tv-ip>          # telemetry, Xiaomi extras, PatchWall, Play Auto Installs
tv/debloat.sh <tv-ip> --apps   # also YouTube (SmartTube replaces it), Netflix, AirCast, Spotify, Downloader, SkyShowtime
```

Packages missing on another model are reported as `absent` and skipped. Removing `android.autoinstalls.config.xiaomi.amelie`
(Play Auto Installs) is what stops partner apps from coming back; a Xiaomi
firmware update can still restore apps, so run the script again after one.

## By hand on the TV

- Settings → Privacy → Usage & diagnostics → **off**; Ads → **Delete advertising ID**.
- Leftover work profile: `adb shell pm list users`, then `pm remove-user <id>`.

## USB stick as internal storage

Not usable on this TV: every standby (suspend to RAM) cuts USB power, and on
wake vold sees the stick as removed, kills every app using it and mounts it
again, sometimes not at all. `settings put global mitv_go_suspend 0` is ignored
(the log still says `go to str direct`). Apps and shared storage were moved
back with `pm move-package <pkg> internal` and `pm move-primary-storage internal`
on 2026-10-28; the stick holds nothing now.

Stremio streams through the NucBox (`nucbox/stremio-server.container`, cache
10 GB there): Stremio → Settings → Server → URL `http://192.168.68.50:11470/`. Stremio → Settings → Playback → **Experimental ASS subtitles support** off: anime ASS subtitles (libass) run the 32-bit app out of memory and it crashes; off, they show as plain text. iPad (needs HTTPS): `https://stremio.casa.byfc.pt/` (`nucbox/caddy-stremio.sh`). Use Stremio's own player there (not VLC: an external player gets the video only, never the addon's Portuguese subtitles); the server transcodes what the iPad can't play. Embedded subtitles fail when it transcodes, the addon's work. AIOStreams' links reach the server through `AddHost` in `stremio-server.container` (without it: "Probe process exited with code: 1"). Startup on the iPad is the probe plus the first transcoded segment (S04E05: BluRay HEVC 10-bit + Opus 9 s, WEB 720p 4-6 s): pick a WEB/MP4 file there, or use Infuse (Settings → Player → external): it plays the MKV directly, starts in 1-2 s and fetches Portuguese subtitles from OpenSubtitles itself (an external player never gets the addon's). The TV plays the BluRay directly. GPU (VAAPI) was tried: the official image's Mesa 18 can't drive the 780M, and on trixie's Mesa it was slower (1.5 s vs 0.6 s per segment) with 10x larger segments.
Back to `http://127.0.0.1:11470/` when the NucBox is off. The TV's own server
keeps "no caching" (`cacheSize` 0; its torrent cache would fill the TV)
and "Run in background" is off, so it does not start (~116 MB RAM).

Streams come from one addon, AIOStreams on the NucBox (`nucbox/aiostreams.container`,
`https://aiostreams.casa.byfc.pt`, `nucbox/caddy-aiostreams.sh`), in place of Torrentio, TorrentsDB
and Brazuca. Stremio on the TV crashed with `rust_oom` (2026-11-02 to 11-05): the 32-bit app sits near
its ~3 GB address space, and each addon's long stream list pushed it over. AIOStreams asks Torrentio,
Comet, MediaFusion, StremThru Torz and, for anime, SeaDex through TorBox (TorrentsDB dropped 2026-11-06: 0-1 of
~100 streams per title after dedup) and returns at most 6 cached streams:
1080p/720p (the panel is 1920×1080; 576p/480p and unknown resolution or quality only when no cached 720p/1080p
exists, an `excludedStreamExpressions` rule, for old shows; unknown quality stays when the file has Portuguese subtitles, as fansub names like Erai-raws carry no WEB/BluRay tag), no 4K, REMUX, Dolby Vision (the panel has HDR10/HDR10+/HLG),
3D, AI upscales or cam, films up to 15 GB, episodes up to 5 GB, original audio then English then Portuguese.
Anime sorts files with Portuguese subtitles inside (`preferredSubtitles`, from the name or a probe) right after cached, then SeaDex (the community's best release, usually BD with Japanese audio): AoT S04 gets Erai-raws (H.264 + AAC, pt-BR inside) first, which Infuse and the iPad play with Portuguese at once.
Season/episode, title, episode-title and year matching drop files of another episode (One Piece S01E01 got
SeaDex's S08E01 and 0229 before; `excludedKeywords` also drop the "One Piece Log: Fish-Man Island Saga" recap).
`excludedLanguages` lists every language but English, Japanese, Portuguese (PT/BR), multi/dual and Unknown: a file
goes only when all its languages are listed, and one in the title's original language counts as "Original", so
Amélie in French or Parasite in Korean stay. RemuxDB is off (`remuxDb.enabled: false`: only 2 s timeouts).
Only files already cached on TorBox show while any is (`excludedStreamExpressions`
`count(cached(streams)) > 0 ? uncached(streams) : false`, `excludeUncached` off), so a title always has an option:
with none cached the list shows TorBox downloads ("TB" without "Instant"), which play once TorBox has fetched
them, minutes later. A show with no cached 1080p (Get Organized with The Home Edit S02 had a lone 720p) gets one
by adding the season pack once in TorBox; it is then cached for good. `TMDB_ACCESS_TOKEN` in `~/.aiostreams/env` (free, themoviedb.org → Settings → API)
gives films their original language; without it "original audio first" applies only to series.
Subtitles: the file's own first (always in sync; streams sort cached, language, subtitle, then resolution,
so one with embedded Portuguese wins over a sharper one without), OpenSubtitles V3+ in pt-PT and pt-BR
as the fallback (20 s timeout, that server is slow; matched to the title, not the release, so it can lag).
No hash match exists for most debrid files and V3+ keeps a fixed order, so its preset URL is
`http://127.0.0.1:11472`: `nucbox/subsort.py` (`subsort.container`, in aiostreams' network) puts the one
named most like the playing file first (group, WEB/BluRay, "Official" for WEB) and turns V3+'s
"Portuguese (BR)", a blank language in Stremio, into `pob`. When Stremio sends the file's hash and the
official OpenSubtitles has any subtitle for that exact file (any language), that one's timing is the
reference and the Portuguese ones are ordered by drift from it (Severance S01E01: ION10 0.00 s first,
a BluRay one 0.85 s last). Each pick is in `journalctl --user -u subsort`. Check: `python3 nucbox/subsort.py --test`.
Torrentio leaves out Rutor/Rutracker and the dub trackers (Comando, BluDV, Mico-Leão, Torrent9): their
files play a dub (Russian, Portuguese) by default. Inside a multi-audio file the player picks the track:
Stremio → Settings → Player → Audio Track Japanese, Secondary Audio Track English (it has only two slots).
Its configure page holds the TorBox key; the config's UUID and password are kept outside the repo.
Backup (outside the repo, mode 600): `~/backups/aiostreams/` holds `env` (the `SECRET_KEY` that decrypts
the config) and `db-<date>.sqlite`, taken while running with Python's `sqlite3` backup
(`src.backup(dst)`), every night by `nucbox/aiostreams-backup.timer` (`aiostreams-backup.py`, keeps the latest;
run `systemctl --user start aiostreams-backup` after changing the config). The image is pinned to a release
(`aiostreams.container`, no AutoUpdate): upgrade by changing the tag. Restore: stop `aiostreams`, copy `env` to
`~/.aiostreams/env` and the db to `~/.aiostreams/data/db.sqlite` (delete `db.sqlite-wal`/`-shm`), start it.
The ElfHosted copy of the config was deleted on 2026-11-05.
`*.casa.byfc.pt` resolves only on the home DNS: installing it from a device on Cloudflare WARP / 1.1.1.1
(or iCloud Private Relay) fails with "Failed to fetch: Load failed". On a Mac, WARP can stay on with
`echo "nameserver 192.168.68.50" | sudo tee /etc/resolver/casa.byfc.pt` (check: `scutil --dns | grep -A3 casa.byfc.pt`;
at home only); elsewhere turn it off or use Tailscale.

What follows is kept for a TV that does keep USB powered.

1. Plug it in with the TV **off at the wall**, in the port labelled with a
   voltage (more current). In the other port the stick kept dropping.
2. Format it as internal storage on the TV, or `sm list-disks` then
   `sm partition disk:8,0 private`; `sm list-volumes private` gives the UUID.
3. Check it stays mounted for a few minutes, then move user apps one at a time
   and open each: `pm move-package <pkg> <uuid>`. The launcher stays internal.

If apps on the stick vanish from the home screen after it dropped, power-cycle
the TV.

## Projectivy launcher

Google TV cannot show chosen app channels under the favourites; Projectivy
(Play Store, free) can, sitting on top of Google TV.

1. Install and open it. Onboarding: deny photos, **allow TV listings** (that
   is what brings channels), deny notifications and usage reports.
2. Run `tv/debloat.sh <tv-ip>` again: it makes Projectivy the system Home
   and disables the stock launcher (`launcherx` on Google TV, `tvlauncher` on
   the Android TV MOOQ0) and `setupwraith`, whose black RecoveryActivity would
   otherwise take Home. Home then never shows the stock home, not even for a
   moment, and closes the screensaver. Leave
   Projectivy's accessibility **button remapping** off: it swallows Home while
   the screensaver runs (only Back closes it).
3. Gear → **Edit channels**: hide "Watch next"; turn on MEO (Tendências TV,
   Tendências VideoClube) and SmartTube (Subscriptions, Recommended, History),
   each channel's **Visible** switch.
4. Gear → **Edit categories**: hide Settings, Display, Applications, System,
   About. Inputs (HDMI) and TV apps stay.
5. Long-press an app in the row → **Hide** (Settings, Live TV,
   Play Store) or **Reorder**.
6. Home button and a reboot must both land in Projectivy.

Barba Negra and Stremio publish no channels.

Backup of the finished setup (living room TV, 2026-11-01, restored on the
second TV the same day) is outside the repo, on the NucBox:
`~/backups/tv/projectivy-sala-2026-11-01.ab` (it also holds Firebase IDs
and crash logs). Taken with `adb backup -f <file> -noapk com.spocky.projengmenu`;
put it on another TV with Projectivy installed: `adb restore <file>` and confirm
on screen. Channel rows follow the app name (MEO, Prime Video, SmartTube); no
setting reorders them.

## Remote app buttons (living room TV)

The YouTube (keycode 190), Netflix (193) and Xiaomi TV+ (192) buttons are
hard-wired in `MiTvSetupCustomizer` (GlobalKeyReceiver) to their stock apps; no
setting changes them, and Projectivy only remaps Menu/Back. Key Mapper does it
(FOSS, `keymapper-<ver>-foss.apk` from GitHub releases): YouTube → SmartTube,
Netflix → Stremio, TV+ → Barba Negra. The stock action still fires and fails
silently, since those apps are uninstalled.

```
adb install keymapper-4.6.2-foss.apk
adb shell settings put secure enabled_accessibility_services \
  "$(adb shell settings get secure enabled_accessibility_services):io.github.sds100.keymapper/io.github.sds100.keymapper.system.accessibility.MyAccessibilityService"
adb shell dumpsys deviceidle whitelist +io.github.sds100.keymapper
adb shell appops set io.github.sds100.keymapper MANAGE_EXTERNAL_STORAGE allow
adb push key_maps_botoes.zip /sdcard/Download/   # zip holding data.json
```

Then Key Mapper → ⋮ → Import → the zip → Replace. On TV the import only lists
`.zip` files in Downloads. `data.json` (old format v10, migrated on import):

```json
{"keymap_db_version": 10, "keymap_list": [
 {"id": 1, "uid": "<uuid>", "isEnabled": true, "flags": 0, "constraintList": [], "constraintMode": 1,
  "trigger": {"mode": 2, "flags": 0, "extras": [], "keys": [{"keyCode": 190, "clickType": 0, "flags": 0,
    "deviceId": "io.github.sds100.keymapper.ANY_DEVICE", "uid": "<uuid>"}]},
  "actionList": [{"type": "APP", "data": "org.smarttube.stable", "flags": 0, "extras": [], "uid": "<uuid>"}]}
]}
```

Same entry for 193 → `com.stremio.one` and 192 → `com.nathnetwork.barbanegraxc`.
The Apps button (284, `KEYCODE_ALL_APPS`) opens Android's app list; it maps to
Projectivy's All apps panel with an `INTENT` action:
`"data": "intent:#Intent;action=tv.projectivy.ALL_APPS;launchFlags=0x10000000;component=com.spocky.projengmenu/.ui.sidePanels.settingsShortcuts.AllAppsSidePanelActivity;end"`,
extras `extra_intent_target` = `ACTIVITY` and `extra_intent_description` = any label.
Its two permanent notifications: TV Settings → Apps → Key Mapper →
Notifications off (`appops POST_NOTIFICATION ignore` did not hide them). Never
`am force-stop` it: Android marks the accessibility service crashed and does not
rebind it; set `enabled_accessibility_services` without it, then with it again.
Keys injected with `adb shell input keyevent` bypass it; test with the remote.
Unlike Projectivy's remapping, it leaves Home closing the screensaver. Start the
screensaver for a test with `adb shell service call dreams 1` (`2` stops it).

## Sound (second TV, MiTV-MOOQ0)

Level 1 was too loud and voices too quiet. No firmware setting lowers the volume
curve (checked the `g_audio__*` keys in MiTVSettings). What helps:

- `settings put global sound_advanced_dialogue_enhancer 1` and
  `sound_advanced_volume_leveler 1` (the TV service applies them; not in the menu).
  Sound mode back to Default (the Custom mode had every EQ band at -10).
- Precise Volume 2.0 (not on the TV's Play Store: APKMirror bundle, signer cert
  SHA-256 `7372a085…af66a`), `adb install-multiple base.apk split_config.armeabi_v7a.apk
  split_config.pt.apk split_config.en.apk split_config.xhdpi.apk`, then
  `pm grant com.phascinate.precisevolume android.permission.DUMP` for the global
  effect. Equalizer → Graphic EQ: preset Vocals, post-gain -18 dB.
- Stremio → Settings → Playback: audio passthrough off (passthrough skips the
  equalizer), player VLC. Stereo sources keep music and voice in one mix, so the
  EQ can only do so much there.

## Close

```
adb shell settings put global development_settings_enabled 0
adb shell settings put global adb_enabled 0
```

Port 5555 closes; turn USB debugging back on to use adb again. Back to Google
TV: uninstall Projectivy.

## Traps

- **Do not uninstall Live TV** (`com.mitv.livetv`): it is the HDMI input
  selector and the Input button. Hide it in the launcher instead.
- **Never disable `launcherx` alone**: Home then opens a black setup screen
  (`setupwraith/.RecoveryActivity`); disable `setupwraith` with it, as the
  script does. Shell cannot disable a single activity (SecurityException).
  Undo: `pm enable com.google.android.apps.tv.launcherx` and the same for
  `com.google.android.tungsten.setupwraith`.
- **Apps-only mode** turns off search and voice.
- Moving an app whose data was on a stick that was later reformatted broke
  Stremio (`AccessDeniedException`); `pm clear` did not fix it, a reinstall did.
  MEO hit the same on 2026-11-03 (opens and closes at once, `mkdir failed:
  EACCES` on its data dir): pull its APKs (`pm path`), `adb uninstall`, then
  `adb install-multiple -i com.android.vending <apks>`; log in again.
  A second `pm move-package` hung and left the app "frozen" until a reboot.
- `sm forget <uuid>` clears old storage records; never the stick in use (its
  apps are lost).
- Driving menus over adb: `input tap` does not move TV focus; use
  `input keyevent DPAD_*` and `uiautomator dump` to read the focused item.
