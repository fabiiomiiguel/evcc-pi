#!/usr/bin/env bash
# The window script: renames ~/Projects to ~/projects on the NucBox and does the devbox/dogchefbox switch-over in the same
# window (plan: rename-projects-lowercase plan.md section B; switch-over: devbox-dogchefbox-impl plan section 5).
# Run it from a plain terminal (ssh or a tty) outside ~/Projects, with every Claude session closed:
#   bash ~/Projects/personal/evcc-pi/nucbox/rename-projects.sh --dry-run --slot <tree>...   # prints every action, changes nothing
#   bash ~/Projects/personal/evcc-pi/nucbox/rename-projects.sh --slot <tree>...             # the window
# --slot <tree>  a dev worktree whose dev-apps replica is recreated after the restart (repeatable; old or new path);
#                --no-slots says there are none. One of them is required, so a forgotten slot is a decision, not an accident.
# Steps: stop Orca, back up (~/backup-projects-rename-<date>, skipped once its .done exists), stop the dev stack and both
# containers, mv + compat symlink ~/Projects -> projects, git worktree links, Claude state (project dirs, json paths, history
# project fields), install box/wrapper, LXD disks of dev and personal, restart + docker recreate + slots, CLAUDE.md block,
# handoffs, devbox -> box, Orca registry, start Orca. Each step is verified; the first failure stops the run with the
# rollback for that step. A re-run continues: done steps detect their state and skip. Live runs refuse to start from inside
# ~/Projects, from a Claude or Orca process, or while a claude process runs; a dry-run only says it would.
# Test seams: BACKUP_DIR, RENAME_PERSONAL_SCRIPT, PROC_DIR and RENAME_START_PID (the ancestor check).
set -eEuo pipefail

OLD=$HOME/Projects
NEW=$HOME/projects
BK=${BACKUP_DIR:-$HOME/backup-projects-rename-$(date +%F)}
PROC=${PROC_DIR:-/proc}
WRAP=$HOME/.local/claude-wrap
SELF=$(realpath "$0")
DRY=0; NO_SLOTS=0; SLOTS=()
STEP=0; CUR=; RB=
CLAUDE_STATE=("$HOME/.claude" "$HOME/.claude-business")
JSON_FILES=("$HOME/.claude.json" "$HOME/.claude-business/.claude.json" "$HOME/.claude/settings.json"
  "$HOME/.claude/plugins/known_marketplaces.json" "$HOME/.claude/plugins/installed_plugins.json")
ORCA_DB=$HOME/.config/orca/profiles/local-default/profile-state.db
HANDOFFS=dogchef/handoffs

say() { echo "==> $*"; }
die() { echo "rename-projects: $*" >&2; exit 1; }
usage() { sed -n '2,/^set -e/p' "$SELF" | sed '$d;s/^# \{0,1\}//'; }
run() { if ((DRY)); then echo "+ $*"; else "$@"; fi; }
# verify <what> <command...>: in a dry-run only names the check
verify() {
  local what=$1; shift
  if ((DRY)); then echo "  verify: $what"; return 0; fi
  "$@" || { echo "  verify FAILED: $what" >&2; return 1; }
  echo "  ok: $what"
}
step() { STEP=$((STEP + 1)); CUR=$1; RB=$2; echo; say "[$STEP] $1"; }
fail() {
  trap - ERR
  { echo; echo "rename-projects: FAILED at step [$STEP] $CUR (exit $1, line $2)"
    echo "Rollback for this step: $RB"
    echo "Whole rollback: see README 'Renaming ~/Projects'; backups are in $BK. Fix the cause and run the same command again."
  } >&2
  exit 1
}
trap 'fail $? $LINENO' ERR

# regex-escape a literal for sed -E (delimiter #)
ere() { sed 's/[][\.*^$+?(){}|#]/\\&/g' <<<"$1"; }
OLD_RE=$(ere "$OLD")
# every OLD path in a file -> NEW, whole path components only, symlinks kept (--follow-symlinks)
sed_paths() { sed -i --follow-symlinks -E "s#$OLD_RE([/\"]|\$)#$NEW\\1#g" "$@"; }
json_ok() { python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' "$1"; }
lxc_state() { lxc list "^$1\$" -f csv -c s 2>/dev/null || true; }
has_instance() { lxc info "$1" >/dev/null 2>&1; }
proj_root() { if [[ -d $NEW && ! -L $NEW ]]; then echo "$NEW"; else echo "$OLD"; fi; }
# a path given under the old name, as it will be named
newpath() { if [[ $1 == "$OLD" || $1 == "$OLD"/* ]]; then echo "$NEW${1#"$OLD"}"; else echo "$1"; fi; }
repo_dir() { newpath "$(dirname "$SELF")/.."; }
# claude keys its per-folder state by the cwd with every non-alphanumeric turned into -
claude_key() { sed 's/[^A-Za-z0-9]/-/g' <<<"$1"; }

# the .git link files and gitdir back pointers under the given roots
git_links() {
  find "$@" \( -name node_modules -o -name vendor -o -name .cache \) -prune -o \
    \( -name .git -type f -print \) -o \( -path '*/.git/worktrees/*/gitdir' -type f -print \) 2>/dev/null
}
# "prunable=N broken=M": worktree entries git marks prunable, and linked worktrees whose .git no longer resolves
git_health() {
  local r p=0 b=0 n f
  while IFS= read -r r; do
    n=$(git -C "$(dirname "$r")" worktree list --porcelain 2>/dev/null | grep -c '^prunable' || true); p=$((p + n))
  done < <(find "$(proj_root)" -maxdepth 3 -name .git -type d 2>/dev/null)
  while IFS= read -r f; do
    [[ $f == */.git ]] || continue
    git -C "$(dirname "$f")" rev-parse --git-dir >/dev/null 2>&1 || b=$((b + 1))
  done < <(git_links "$(proj_root)" "$HOME/orca/workspaces")
  echo "prunable=$p broken=$b"
}
health_not_worse() { # before-file
  local a b; a=$(git_health); b=$(<"$1")
  local ap=${a#prunable=} bp=${b#prunable=}
  ((${ap%% *} <= ${bp%% *} && ${a##*=} <= ${b##*=}))
}

guards() {
  local why=()
  [[ $(pwd -P) == "$OLD" || $(pwd -P) == "$OLD"/* || $PWD == "$OLD" || $PWD == "$OLD"/* ]] && why+=("cwd is inside $OLD: cd ~ first")
  [[ -n ${CLAUDECODE:-}${CLAUDE_CODE_ENTRYPOINT:-} ]] && why+=("running inside a Claude Code session")
  [[ -n $(env | grep -m1 '^ORCA_' || true) ]] && why+=("running inside an Orca terminal")
  local p=${RENAME_START_PID:-$$} cmd
  while ((p > 1)) && [[ -r $PROC/$p/status ]]; do
    cmd=$(tr '\0' ' ' <"$PROC/$p/cmdline" 2>/dev/null || true)
    if grep -Eq '(^|[ /])(claude|orca-ide)( |$)|/opt/Orca/|claude-code' <<<"$cmd"; then why+=("a parent process is Claude or Orca ($cmd)"); break; fi
    p=$(awk '/^PPid:/{print $2}' "$PROC/$p/status")
  done
  pgrep -x claude >/dev/null 2>&1 && why+=("a claude process is running: close every session")
  local w
  for w in "${why[@]}"; do
    if ((DRY)); then say "dry-run: a live run would refuse: $w"; else echo "rename-projects: refusing: $w" >&2; fi
  done
  ((DRY || ${#why[@]} == 0)) || exit 1
}

preflight() {
  local t
  for t in lxc git python3 pgrep systemctl sed awk find install; do command -v "$t" >/dev/null || die "$t not found"; done
  [[ -d $OLD || -d $NEW ]] || die "neither $OLD nor $NEW exists"
  if [[ -d $OLD && ! -L $OLD && -d $NEW && ! -L $NEW ]]; then die "$OLD and $NEW are both real directories; merge by hand"; fi
  if ((!NO_SLOTS && ${#SLOTS[@]} == 0)); then
    die "name the dev slots to recreate with --slot <worktree> (repeatable) or say --no-slots (docker ps in dev shows what runs)"
  fi
  local s
  for s in "${SLOTS[@]}"; do [[ -d $s || -d $(newpath "$s") ]] || die "slot $s does not exist"; done
  [[ -f $(repo_dir)/nucbox/box || ${DRY} == 1 ]] || die "$(repo_dir)/nucbox/box missing"
  guards
}

stop_orca() {
  step "stop Orca" "systemctl --user start orca.service"
  run systemctl --user stop orca.service
  local u
  for u in $(systemctl --user list-units 'orca-daemon-*.scope' --no-legend 2>/dev/null | awk '{print $1}'); do run systemctl --user stop "$u"; done
  verify "no Orca process left (quit the Orca app if it is still open)" bash -c '! pgrep -f /opt/Orca/ >/dev/null'
}

backup() {
  step "back up to $BK" "nothing changed yet; delete $BK if it is partial"
  if [[ -e $BK/.done ]]; then say "backup already complete ($BK/.done)"; return; fi
  run mkdir -p "$BK"
  local f
  for f in "${JSON_FILES[@]}" "${CLAUDE_STATE[@]/%//history.jsonl}" "$HOME/.claude/CLAUDE.md" "$HOME/.local/bin/devbox" "$ORCA_DB" "$ORCA_DB-wal" "$ORCA_DB-shm"; do
    [[ -e $f || -L $f ]] && run cp -a --parents "$f" "$BK/"
  done
  [[ -d $WRAP ]] && run cp -a --parents "$WRAP" "$BK/"
  [[ -d $OLD/$HANDOFFS ]] && run cp -a --parents "$OLD/$HANDOFFS" "$BK/"
  local i
  for i in dev personal; do
    has_instance "$i" && { if ((DRY)); then echo "+ lxc config show $i > $BK/lxc-$i.txt"; else lxc config show "$i" > "$BK/lxc-$i.txt"; fi; }
  done
  if ((DRY)); then echo "+ record git link before-state, git health and docker volumes in $BK"; else
    local l
    while IFS= read -r l; do printf '%s\t%s\n' "$l" "$(<"$l")"; done < <(git_links "$OLD" "$HOME/orca/workspaces") > "$BK/git-links.tsv"
    git_health > "$BK/git-health.txt"
    if [[ $(lxc_state dev) == RUNNING && -d $OLD/dogchef/dev ]]; then
      (cd "$OLD/dogchef/dev" && dogchefbox docker volume ls -q | sort) > "$BK/volumes-before.txt"
    else : > "$BK/volumes-before.txt"; fi
  fi
  run touch "$BK/.done"
  verify "backup marker present" test -e "$BK/.done"
}

stop_stack() {
  step "stop the dev stack and both containers" "lxc start dev personal; then re-run this script"
  if [[ $(lxc_state dev) == RUNNING && -d $(proj_root)/dogchef/dev ]]; then
    (cd "$(proj_root)/dogchef/dev" && run dogchefbox bash .claude/scripts/slot.sh down-all && run dogchefbox make stop)
  fi
  local i
  for i in dev personal; do [[ $(lxc_state "$i") == RUNNING ]] && run lxc stop "$i"; done
  verify "dev and personal are stopped" bash -c '! { lxc list -f csv -c ns | grep -E "^(dev|personal)," | grep -q RUNNING; }'
}

rename_dir() {
  step "mv $OLD $NEW and leave the compat symlink" "rm $OLD && mv $NEW $OLD"
  if [[ -d $NEW && -L $OLD ]]; then say "already renamed"; else
    run mv "$OLD" "$NEW"
    run ln -s projects "$OLD"
  fi
  verify "$NEW is a directory and $OLD points at it" bash -c '[[ -d $1 && ! -L $1 && $(readlink "$2") == projects ]]' _ "$NEW" "$OLD"
}

fix_git() {
  step "rewrite the git worktree links" "sed the other way over $BK/git-links.tsv (cut -f1 lists the files) or restore its contents"
  local files; files=$(git_links "$(proj_root)" "$HOME/orca/workspaces" | xargs -d '\n' -r grep -lF "$OLD" || true)
  if [[ -z $files ]]; then say "no link points at $OLD"; else
    if ((DRY)); then echo "+ sed -i 's#$OLD/#$NEW/#' on $(wc -l <<<"$files") link files"; else
      xargs -d '\n' sed -i -E "s#(^|gitdir: )$OLD_RE/#\\1$NEW/#" <<<"$files"; fi
  fi
  verify "git worktrees are no worse than before ($(cat "$BK/git-health.txt" 2>/dev/null || echo 'before-state not recorded'))" health_not_worse "$BK/git-health.txt"
}

claude_state() {
  step "Claude state: project dirs, json paths, history" "restore from $BK (cp -a --parents copies keep the full path) and mv the project dirs back"
  local acct d t okey nkey
  okey=$(claude_key "$OLD"); nkey=$(claude_key "$NEW")
  for acct in "${CLAUDE_STATE[@]}"; do
    for d in "$acct/projects/$okey" "$acct/projects/$okey"-*; do
      [[ -d $d ]] || continue
      t=$acct/projects/$nkey${d#"$acct/projects/$okey"}
      [[ ! -e $t ]] || die "$t exists already; merge it with $d by hand"
      run mv "$d" "$t"
    done
  done
  local f
  for f in "${JSON_FILES[@]}"; do
    [[ -f $f ]] && grep -q "$OLD" "$f" || continue
    if ((DRY)); then echo "+ sed_paths $f"; else
      sed_paths "$f"
      json_ok "$f" || { cp -a "$BK$f" "$f"; die "$f is not valid json after the rewrite; restored it from the backup"; }
    fi
  done
  for acct in "${CLAUDE_STATE[@]}"; do
    [[ -f $acct/history.jsonl ]] || continue
    run sed -i -E "s#(\"project\":\")$OLD_RE([/\"])#\\1$NEW\\2#" "$acct/history.jsonl"
  done
  verify "no old path in the claude json files" bash -c '! grep -lE "$1([/\"])" "${@:2}" 2>/dev/null | grep -q .' _ "$OLD_RE" "${JSON_FILES[@]}"
  verify "no old project field in the histories" bash -c '! grep -lE "\"project\":\"$1" "${@:2}" 2>/dev/null | grep -q .' _ "$OLD_RE" "${CLAUDE_STATE[@]/%//history.jsonl}"
  verify "no -home-...-Projects dir left under the claude projects dirs" bash -c '
    ! compgen -G "$1/projects/$2*" >/dev/null && ! compgen -G "$3/projects/$2*" >/dev/null' _ "${CLAUDE_STATE[0]}" "$okey" "${CLAUDE_STATE[1]}"
}

deploy_scripts() {
  local r; r=$(repo_dir)
  step "install the wrapper and box from the repo at its new path" "bash $BK$WRAP/... : cp -a the saved $WRAP back"
  run bash "$r/nucbox/claude-business.sh"
  run install -m 755 "$r/nucbox/box" "$WRAP/box"
  run ln -sfn "$WRAP/box" "$HOME/.local/bin/dogchefbox"
  verify "deployed is-business-dir.sh equals the repo's" cmp -s "$r/nucbox/is-business-dir.sh" "$WRAP/is-business-dir.sh"
  verify "$NEW/dogchef/handoffs counts as a dogchef folder" bash -c '. "$1"; is_business_dir "$2"' _ "$WRAP/is-business-dir.sh" "$NEW/$HANDOFFS"
}

# the lxd scripts add by name and keep a device that exists, so a disk still sourced from the old path goes first
drop_old_disks() {
  local d src
  for d in $(lxc config device list "$1" | grep -x 'projects\|m-p-.*' || true); do
    src=$(lxc config device get "$1" "$d" source)
    if [[ $src == "$OLD" || $src == "$OLD"/* ]]; then run lxc config device remove "$1" "$d"; fi
  done
}

lxd_mounts() {
  local r d; r=$(repo_dir)
  step "LXD disks: dev gets dogchef only, personal the rest" "lxc config device add from $BK/lxc-dev.txt and lxc-personal.txt with the old sources, then lxc start dev personal"
  if has_instance dev; then
    drop_old_disks dev
    run bash "$r/nucbox/lxd-dev-mounts.sh"
    run lxc start dev
    run lxc exec dev -- cloud-init status --wait >/dev/null || true
    run lxc exec dev -- install -d -o fabio -g fabio -m 755 "$NEW" "$HOME/orca" "$HOME/orca/workspaces"
    verify "dev devices name no $OLD" bash -c '! lxc config device show dev | grep -qF "$1"' _ "$OLD"
  else say "no instance dev: skipped"; fi
  if has_instance personal; then
    drop_old_disks personal
    run bash "${RENAME_PERSONAL_SCRIPT:-$r/nucbox/lxd-personal.sh}"
    verify "personal devices name no $OLD" bash -c '! lxc config device show personal | grep -qF "$1"' _ "$OLD"
  else say "no instance personal: skipped (create it with nucbox/lxd-personal.sh)"; fi
}

docker_recreate() {
  step "recreate the dev stack and the slots from the new path" "cd $NEW/dogchef/dev && dogchefbox make start (the volumes are kept)"
  local s dev; dev=$(proj_root)/dogchef/dev
  has_instance dev || { say "no instance dev: skipped"; return; }
  (cd "$dev" && run dogchefbox make start)
  for s in "${SLOTS[@]}"; do (cd "$dev" && run dogchefbox bash .claude/scripts/slot.sh ensure "$(newpath "$s")"); done
  verify "no container mounts a path under $OLD" bash -c '
    ! (cd "$2" && dogchefbox bash -c "docker ps -q | xargs -r docker inspect --format \"{{range .Mounts}}{{.Source}} {{end}}\"") | grep -qF "$1"' _ "$OLD" "$dev"
  verify "every docker volume from before still exists" bash -c '
    [[ -z $(comm -23 "$1" <(cd "$2" && dogchefbox docker volume ls -q | sort)) ]]' _ "$BK/volumes-before.txt" "$dev"
}

claude_md_block() {
  local r md=$HOME/.claude/CLAUDE.md; r=$(repo_dir)
  step "~/.claude/CLAUDE.md: the two-container block" "cp $BK$md $md"
  if grep -q '^# Two LXD containers' "$md"; then say "block already replaced"; else
    grep -q '^# dogchef-be repos run inside' "$md" || die "the old block heading is not in $md; replace the block by hand from nucbox/claude-devbox.md"
    if ((DRY)); then echo "+ awk: replace the block from '# dogchef-be repos run inside' up to the next '# ' heading with nucbox/claude-devbox.md"; else
      local tmp; tmp=$(mktemp)
      awk -v f="$r/nucbox/claude-devbox.md" 'BEGIN{while((getline l<f)>0)n=n l "\n"} /^# dogchef-be repos run inside/{s=1; printf "%s\n", n; next} s&&/^# /{s=0} !s' "$md" > "$tmp"
      cat "$tmp" > "$md"; rm -f "$tmp"
    fi
  fi
  verify "new block in, no old path or old devbox meaning left" bash -c '
    grep -q "^# Two LXD containers" "$1" && ! grep -qE "~/Projects|never use devbox" "$1"' _ "$md"
}

handoffs() {
  step "dogchef handoffs: devbox -> dogchefbox, old path -> new" "cp -a the saved $BK$OLD/$HANDOFFS back"
  local dir=$NEW/$HANDOFFS
  if [[ -d $dir ]]; then
    run sed -i -E "s/\\bdevbox\\b/dogchefbox/g; s#~/Projects#~/projects#g; s#$OLD_RE([/\"]|\$)#$NEW\\1#g" "$dir"/*.md
    verify "handoffs say neither devbox nor the old path" bash -c '! grep -qE "\bdevbox\b|Projects" "$1"/*.md' _ "$dir"
  else say "no $dir: skipped"; fi
}

devbox_link() {
  step "devbox now means personal" "cp -a $BK$HOME/.local/bin/devbox $HOME/.local/bin/devbox (the old one-liner to dev)"
  run ln -sfn "$WRAP/box" "$HOME/.local/bin/devbox"
  local pe=$NEW/personal/evcc-pi de=$NEW/dogchef/dev
  verify "devbox runs in a personal folder" bash -c 'cd "$1" && devbox true' _ "$pe"
  verify "devbox refuses a dogchef folder" bash -c 'cd "$1" && ! devbox true 2>/dev/null' _ "$de"
  verify "dogchefbox refuses a personal folder" bash -c 'cd "$1" && ! dogchefbox true 2>/dev/null' _ "$pe"
}

orca_registry() {
  step "Orca registry: paths and content hashes" "cp -a $BK$ORCA_DB(-wal,-shm) back over $ORCA_DB, or re-add the repos in the Orca UI"
  if [[ ! -f $ORCA_DB ]]; then say "no $ORCA_DB: skipped"; return; fi
  if ((DRY)); then echo "+ python3: replace $OLD by $NEW in profile_state_documents.payload and recompute content_hash (sha256) of the changed rows"; else
    python3 -I - "$ORCA_DB" "$OLD" "$NEW" <<'PY'
import hashlib, sqlite3, sys
db, old, new = sys.argv[1:]
c = sqlite3.connect(db)
rows = c.execute("select domain, payload from profile_state_documents where instr(payload, ?) > 0", (old,)).fetchall()
with c:
    for domain, payload in rows:
        payload = payload.replace(old, new)
        c.execute("update profile_state_documents set payload=?, content_hash=? where domain=?",
                  (payload, hashlib.sha256(payload.encode()).hexdigest(), domain))
print(f"  {len(rows)} rows rewritten")
PY
  fi
  verify "no old path, hashes match, integrity ok" python3 -I - "$ORCA_DB" "$OLD" <<'PY'
import hashlib, sqlite3, sys
db, old = sys.argv[1:]
c = sqlite3.connect(db)
bad = [d for d, p, h in c.execute("select domain, payload, content_hash from profile_state_documents")
       if old in p or hashlib.sha256(p.encode()).hexdigest() != h]
sys.exit(1 if bad or c.execute("pragma integrity_check").fetchone()[0] != "ok" else 0)
PY
  run systemctl --user start orca.service
}

main() {
  while (($#)); do
    case $1 in
      --dry-run) DRY=1 ;;
      --slot) [[ -n ${2:-} ]] || die "--slot needs a worktree"; SLOTS+=("$2"); shift ;;
      --no-slots) NO_SLOTS=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; exit 64 ;;
    esac
    shift
  done
  if ((NO_SLOTS && ${#SLOTS[@]})); then die "--no-slots and --slot together"; fi
  preflight
  ((DRY)) && say "dry-run: nothing below is executed"
  stop_orca; backup; stop_stack; rename_dir; fix_git; claude_state; deploy_scripts; lxd_mounts
  docker_recreate; claude_md_block; handoffs; devbox_link; orca_registry
  cat <<MSG

Done. By hand now:
  - dogchef/handoffs/dulse.md:7 still says ~/orca is not mounted in dev: it is, for the dogchef workspaces; reword it.
  - open a fresh claude in ~/projects/personal/evcc-pi (memory loads, /resume lists the old sessions) and one in ~/projects/dogchef/dev (business account).
  - start the Orca app; the repos should be listed and a worktree should open.
  - $OLD is only a compat symlink: after a week, with nothing naming it, 'rm $OLD' (a symlink; plain rm).
  - $BK keeps the pre-window copies.
MSG
}
main "$@"
exit
