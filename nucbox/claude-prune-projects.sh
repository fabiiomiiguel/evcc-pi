#!/usr/bin/env bash
# Window follow-up to rename-projects.sh: drops the Claude state of folders that no longer exist: the ~/.claude.json
# `projects` keys and the ~/.claude*/projects/<dir> whose recorded cwd is gone. Run with every claude session closed.
#   bash nucbox/claude-prune-projects.sh --dry-run   # lists what it would remove
#   bash nucbox/claude-prune-projects.sh
# Backup in ~/backup-claude-prune (json copies, timestamped; removed dirs are moved there, same filesystem). A dir with no cwd in its
# session files is kept. Restore: copy the json back, mv the dirs back.
set -euo pipefail

DRY=0; [[ ${1:-} == --dry-run ]] && DRY=1
BK=${BACKUP_DIR:-$HOME/backup-claude-prune}
ACCOUNTS=("$HOME/.claude:$HOME/.claude.json:claude" "$HOME/.claude-business:$HOME/.claude-business/.claude.json:claude-business")

if pgrep -x claude >/dev/null 2>&1; then echo "claude is running: close every session first" >&2; exit 1; fi
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

for entry in "${ACCOUNTS[@]}"; do
  IFS=: read -r dir json name <<<"$entry"

  if [[ -f $json ]]; then
    mapfile -t gone < <(jq -r '.projects // {} | keys[]' "$json" | while IFS= read -r k; do [[ -e $k ]] || printf '%s\n' "$k"; done)
    for k in "${gone[@]}"; do echo "$name: json key $k"; done
    if ((${#gone[@]} && !DRY)); then
      mkdir -p "$BK/$name"; cp -p "$json" "$BK/$name-$(date +%s).json"
      jq --argjson gone "$(printf '%s\n' "${gone[@]}" | jq -R . | jq -s .)" 'del(.projects[$gone[]])' "$json" >"$json.new"
      jq -e . "$json.new" >/dev/null
      cat "$json.new" >"$json"; rm "$json.new"
    fi
  fi

  for d in "$dir"/projects/*/; do
    [[ -d $d ]] || continue
    cwds=$(grep -h -m1 -o '"cwd":"[^"]*"' "$d"*.jsonl 2>/dev/null | sed 's/^"cwd":"//; s/"$//' | sort -u) || true
    [[ -n $cwds ]] || continue
    # rename-projects.sh leaves /Projects/ cwds in the session files; the folder may now be under /projects/
    while IFS= read -r c; do [[ -e $c || ( $c == "$HOME/Projects/"* && -e $HOME/projects${c#"$HOME/Projects"} ) ]] && continue 2; done <<<"$cwds"
    echo "$name: project dir ${d%/} (cwd ${cwds//$'\n'/, })"
    if ((!DRY)); then mkdir -p "$BK/$name/projects"; mv "${d%/}" "$BK/$name/projects/"; fi
  done
done
