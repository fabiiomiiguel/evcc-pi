# Sourced by claude-wrap and box: true when $1 is a dogchef folder (under DOGCHEF_DIR, or a git repo whose origin is in dogchef-be/).
# Unset PROJECTS_DIR: ~/projects, or ~/Projects until the rename (decided at each run, so a rolled-back rename works too).
if [[ -z ${PROJECTS_DIR:-} ]]; then
  PROJECTS_DIR=$HOME/projects
  [[ -d $PROJECTS_DIR || ! -d $HOME/Projects ]] || PROJECTS_DIR=$HOME/Projects
fi
is_business_dir() {
  # physical paths, so a shell in ~/Projects/dogchef/... via the compat symlink still matches
  local dogchef dir
  dogchef=$(realpath -m "${DOGCHEF_DIR:-$PROJECTS_DIR/dogchef}")
  dir=$(realpath -m "$1")
  [[ $dir == "$dogchef" || $dir == "$dogchef"/* ]] || [[ $(git -C "$1" remote get-url origin 2>/dev/null) == *dogchef-be/* ]]
}
# true when an Orca workspace dir ($1) holds a dogchef worktree (an empty workspace is not)
business_workspace() {
  local c
  for c in "$1"/*/; do [[ -d $c ]] && is_business_dir "${c%/}" && return 0; done
  return 1
}
