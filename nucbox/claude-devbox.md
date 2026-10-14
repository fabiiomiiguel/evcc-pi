# dogchef-be repos run inside the `dev` LXD container
On this machine the dogchef dev stack (the `dev` repo's Docker containers: dev-apps, dev-mysql, dev-proxy, ...) runs inside the LXD container `dev`, not on this host. `~/Projects` is mounted there at the same path, so files are the same on both sides; only commands differ.

A repo is dogchef when `git remote get-url origin` contains `dogchef-be/` (today: dev and its worktrees, dev-backoffice-frontend-consolidation, freshchef-ui, nuxt-ab-segment, nuxt-intercom, nuxt-maps, nuxt-prevent-multitabs, proto-dogchefapp). In a dogchef repo:
- Run every `make`, `docker`/`docker compose`, `npm`/`npx`/`node`, `composer`/`php`, test and `.claude/scripts/*.sh` command through `devbox` from the repo directory, e.g. `devbox make start`, `devbox bash .claude/scripts/slot.sh ensure "$PWD"`, `devbox docker exec dev-apps ...`. `devbox` keeps the current directory and runs as fabio with the docker group.
- Run `git commit` (and anything else that fires git hooks, such as `git merge` or `git rebase`) as `devbox git ...`: the hooks need the container's tools. Read-only git (status, diff, log, fetch) is fine on the host.
- Compound commands: `devbox bash -c '...'`.
- `https://<app>.test` only resolves inside the container: check URLs with `devbox curl -sk https://<app>.test/...`. The `preview_start` tool cannot reach the container; serve with `/test` (`test-supervise.sh` via devbox) and check with devbox curl instead.
- Never start the dev stack or any dogchef container with the host's own docker, and never install dogchef dependencies on the host.
- The dev DB cluster is reached through Cloudflare WARP inside the container (`lxc exec dev -- warp-cli --accept-tos status`). If `make reset-db-*` cannot connect, report it; registration needs the user's login.
- After a reboot the stack is down: `cd ~/Projects/dogchef/dev && devbox make start`.

Other repos (not dogchef-be, e.g. football-fines) use this host's php/node directly; never use devbox for them.
