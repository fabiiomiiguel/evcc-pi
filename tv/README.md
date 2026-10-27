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
tv/debloat.sh <tv-ip> --apps   # also YouTube (SmartTube replaces it), Netflix, Prime Video, AirCast
```

Packages missing on another model are reported as `absent` and skipped.
Animations go to 0.5x. Removing `android.autoinstalls.config.xiaomi.amelie`
(Play Auto Installs) is what stops partner apps from coming back; a Xiaomi
firmware update can still restore apps, so run the script again after one.

## By hand on the TV

- Settings → Privacy → Usage & diagnostics → **off**; Ads → **Delete advertising ID**.
- Leftover work profile: `adb shell pm list users`, then `pm remove-user <id>`.

## USB stick as internal storage

Only worth it when space runs out: the ports are USB 2.0 and apps on the stick
open slower. The stick is formatted and tied to this TV; pulled out, its apps
stop opening.

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
2. Run `tv/debloat.sh <tv-ip>` again: it turns on Projectivy's accessibility
   service, which takes the Home button. Check Settings → General →
   **Bypass current launcher** is on.
3. Gear → **Edit channels**: hide "Watch next"; turn on MEO (Tendências TV,
   Tendências VideoClube) and SmartTube (Subscriptions, Recommended, History),
   each channel's **Visible** switch.
4. Gear → **Edit categories**: hide Settings, Display, Applications, System,
   About. Inputs (HDMI) and TV apps stay.
5. Long-press an app in the row → **Hide** (Settings, TV Manager, Live TV,
   Play Store) or **Reorder**.
6. Home button and a reboot must both land in Projectivy.

Barba Negra and Stremio publish no channels.

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
- **Do not disable the Google TV launcher** (`launcherx`): Home then opens a
  black setup screen (`setupwraith/.RecoveryActivity`) that adb cannot disable.
  `pm enable com.google.android.apps.tv.launcherx` undoes it.
- **Apps-only mode** turns off search and voice.
- Moving an app whose data was on a stick that was later reformatted broke
  Stremio (`AccessDeniedException`); `pm clear` did not fix it, a reinstall did.
  A second `pm move-package` hung and left the app "frozen" until a reboot.
- `sm forget <uuid>` clears old storage records; never the stick in use (its
  apps are lost).
- Driving menus over adb: `input tap` does not move TV focus; use
  `input keyevent DPAD_*` and `uiautomator dump` to read the focused item.
