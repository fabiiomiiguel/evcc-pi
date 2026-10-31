#!/usr/bin/env bash
# Debloats a Xiaomi Google TV over the network with adb (no root). See tv/README.md.
# Usage: tv/debloat.sh <tv-ip> [--apps]   (--apps also removes YouTube, Netflix, AirCast, Spotify, Downloader, SkyShowtime)
set -euo pipefail

IP=${1:?usage: $0 <tv-ip> [--apps]}
ADB=${ADB:-adb}
S="$ADB -s $IP:5555 shell"

# pm uninstall --user 0: removed for the user, restored with `cmd package install-existing <pkg>`.
BLOAT=(
  com.miui.tv.analytics com.xiaomi.statistic                       # telemetry
  fusion.android.tv.demo com.google.android.feedback com.xiaomi.mitv.manualhelp
  com.android.printspooler com.xiaomo.tv.milegal com.xiaomi.mitv.scenemode com.mitv.toolhouse
  com.xiaomi.mimusic2 com.mitv.gallery com.mitv.tvhome.mitvplus com.mitv.tvhome.michannel com.xm.webcontent
  com.mitv.tvhome.atv com.mitv.tvhome.oemtab                       # PatchWall
  com.xiaomi.mitv.smartshare com.xiaomi.wfdsinkhelperservice       # Miracast (Chromecast stays)
  com.xiaomi.mitv.mediaexplorer com.xiaomi.mitv.tvmanager           # TV Manager: cleaner with Firebase, always running
  com.google.android.marvin.talkback com.google.android.syncadapters.calendar
  com.google.android.tts com.google.android.play.games              # ~280 MB; TTS voices are only used by TalkBack
  com.xiaomi.amazon.alexa com.mitv.milinkservice com.mitv.dream     # Alexa, Mi Link, Mi screensaver (skipped while it is the active one)
  android.autoinstalls.config.xiaomi.amelie                        # Play Auto Installs: stops partner apps coming back
)
APPS=(com.google.android.youtube.tv com.google.android.youtube.tvmusic com.netflix.ninja com.smartdevice.tv.aircast
      com.spotify.tv.android com.esaba.downloader com.skyshowtime.skyshowtime.google)
# Never here: com.mitv.livetv (it is the HDMI input selector), com.google.android.katniss (voice),
# com.google.android.apps.tv.dreamx (the screensaver: without it the TV suspends at screen_off_timeout, 10 min).

$ADB connect "$IP:5555" >/dev/null
[ "$($S echo ok 2>/dev/null)" = ok ] || { echo "not authorized: accept the prompt on the TV and run again" >&2; exit 1; }

PKGS=("${BLOAT[@]}")
[ "${2:-}" = --apps ] && PKGS+=("${APPS[@]}")
INSTALLED=$($S pm list packages | sed 's/^package://')
DREAM=$($S settings get secure screensaver_components; $S settings get secure screensaver_default_component)
for p in "${PKGS[@]}"; do
  grep -qx "$p" <<<"$INSTALLED" || { echo "absent  $p"; continue; }
  grep -q "^$p/" <<<"$DREAM" && { echo "screensaver, kept  $p"; continue; }   # without it the TV suspends at screen_off_timeout
  echo "$($S pm uninstall --user 0 "$p" | tr -d '\r')  $p"
done

# Projectivy becomes the real Home: launcherx (priority 2) outranks a preferred home, and with it
# disabled setupwraith's black RecoveryActivity (priority 1) would. Shell cannot disable single components.
if grep -qx com.spocky.projengmenu <<<"$INSTALLED"; then
  $S cmd package set-home-activity com.spocky.projengmenu/.ui.home.MainActivity >/dev/null
  $S pm disable-user --user 0 com.google.android.tungsten.setupwraith >/dev/null
  $S pm disable-user --user 0 com.google.android.apps.tv.launcherx >/dev/null
  $S pm clear com.google.android.tungsten.setupwraith >/dev/null; $S pm clear com.google.android.apps.tv.launcherx >/dev/null
  echo "Home: $($S cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME | tail -1)"
fi

$S pm trim-caches 100G   # every app's cache
$S dumpsys meminfo | grep -E 'Free RAM|Used RAM'
echo "Manual steps and closing: tv/README.md"
