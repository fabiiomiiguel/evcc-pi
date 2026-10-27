#!/usr/bin/env bash
# Debloats a Xiaomi Google TV over the network with adb (no root). See tv/README.md.
# Usage: tv/debloat.sh <tv-ip> [--apps]   (--apps also removes YouTube, Netflix, Prime Video, AirCast)
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
  com.xiaomi.mitv.mediaexplorer
  com.google.android.marvin.talkback com.google.android.syncadapters.calendar com.google.android.apps.tv.dreamx
  android.autoinstalls.config.xiaomi.amelie                        # Play Auto Installs: stops partner apps coming back
)
APPS=(com.google.android.youtube.tv com.google.android.youtube.tvmusic com.netflix.ninja
      com.amazon.amazonvideo.livingroom com.smartdevice.tv.aircast)
# Never here: com.mitv.livetv (it is the HDMI input selector), com.google.android.apps.tv.launcherx
# (disabling it leaves Home on a black setup screen), com.google.android.katniss (voice).

$ADB connect "$IP:5555" >/dev/null
[ "$($S echo ok 2>/dev/null)" = ok ] || { echo "not authorized: accept the prompt on the TV and run again" >&2; exit 1; }

PKGS=("${BLOAT[@]}")
[ "${2:-}" = --apps ] && PKGS+=("${APPS[@]}")
INSTALLED=$($S pm list packages | sed 's/^package://')
for p in "${PKGS[@]}"; do
  grep -qx "$p" <<<"$INSTALLED" || { echo "absent  $p"; continue; }
  echo "$($S pm uninstall --user 0 "$p" | tr -d '\r')  $p"
done

for k in window_animation_scale transition_animation_scale animator_duration_scale; do
  $S settings put global $k 0.5
done

# Projectivy takes the Home button through its accessibility service (the Google TV launcher stays enabled).
if grep -qx com.spocky.projengmenu <<<"$INSTALLED"; then
  $S settings put secure enabled_accessibility_services \
    com.spocky.projengmenu/com.spocky.projengmenu.services.ProjectivyAccessibilityService
  $S settings put secure accessibility_enabled 1
  echo "Projectivy: Home button handled"
fi

$S dumpsys meminfo | grep -E 'Free RAM|Used RAM'
echo "Manual steps and closing: tv/README.md"
