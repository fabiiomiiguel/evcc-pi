// rename-projects.sh over a temp HOME with a stub lxc, systemctl and pgrep, real git and python3 sqlite: dry-run changes
// nothing, a live run renames and rewrites every place the plan names (git links, claude state, LXD disks, CLAUDE.md block,
// handoffs, devbox -> box, Orca registry; no `personal` container), the refusals hold, the first failure stops with its rollback, a re-run is a no-op.
// Run: node --test nucbox/tests/rename-projects.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const nucbox = fileURLToPath(new URL("..", import.meta.url));
const script = join(nucbox, "rename-projects.sh");

const LXC = `#!/usr/bin/env bash
s=$STUB_STATE; echo "$*" >> "$s/calls"
case "$1" in
  list) if [[ $2 == -f ]]; then for i in dev; do echo "$i,$(cat "$s/state-$i")"; done; else n=\${2//[^a-z]/}; cat "$s/state-$n"; fi ;;
  info) [[ -e $s/state-$2 ]] ;;
  start) [[ ! -e $s/fail-start ]] || { echo "start failed" >&2; exit 1; }; echo RUNNING > "$s/state-$2" ;;
  stop) echo STOPPED > "$s/state-$2" ;;
  exec) case "$*" in *"volume ls"*) cat "$s/volumes" ;;
    *Destination*) f=$s/volmounts; if grep -q "make start" "$s/calls"; then f=$s/volmounts-after; fi
      # the fixtures hold one line per container in docker's (unstable) mount order; render per mount when the format does
      case "$*" in *':= .Name}}'*) awk '{for (i = 2; i <= NF; i++) print $1, $i}' "$f" ;; *) cat "$f" ;; esac ;;
    *"docker inspect"*) cat "$s/mounts" ;; esac ;;
  config) case "$2" in
    show) echo "config of $3" ;;
    device) case "$3" in
      list) ls "$s" | sed -n "s/^d-$4-//p" ;;
      show) cat "$s"/d-$4-* 2>/dev/null || true ;;
      get) sed -n "s/^source: //p" "$s/d-$4-$5" ;;
      add) echo "source: \${7#source=}" > "$s/d-$4-$5" ;;
      remove) rm -f "$s/d-$4-$5" ;; esac ;;
  esac ;;
esac
exit 0
`;
const devboxMd = readFileSync(join(nucbox, "claude-devbox.md"), "utf8");

const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
const sha = (s) => createHash("sha256").update(s).digest("hex");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "rp-"));
  const state = join(home, "state");
  const O = join(home, "Projects");
  const mk = (...p) => mkdirSync(join(home, ...p), { recursive: true });
  const w = (p, c) => writeFileSync(join(home, p), c);
  for (const d of ["state", "bin", "proc", ".local/bin", ".local/claude-wrap", ".claude/plugins", ".claude-business", "orca/workspaces/dev",
    "Projects/dogchef/dev", "Projects/dogchef/handoffs", "Projects/ffv0", "Projects/oss", ".config/orca/profiles/local-default"]) mk(d);
  w("bin/lxc", LXC);
  w("bin/systemctl", "#!/bin/sh\necho \"systemctl $*\" >> \"$STUB_STATE/calls\"\n");
  w("bin/pgrep", "#!/bin/sh\n[ -e \"$STUB_STATE/claude-running\" ] && [ \"$1\" = -x ] && exit 0\nexit 1\n");
  for (const f of ["lxc", "systemctl", "pgrep"]) spawnSync("chmod", ["+x", join(home, "bin", f)]);
  writeFileSync(join(state, "state-dev"), "RUNNING\n");
  writeFileSync(join(state, "volumes"), "dev_mysql\n");
  writeFileSync(join(state, "volmounts"), "/dev-mysql dev_mysql:/var/lib/mysql \n/dev-apps-sup-1 node_modules:/app/node_modules \n");
  writeFileSync(join(state, "volmounts-after"), "/dev-mysql dev_mysql:/var/lib/mysql \n");
  writeFileSync(join(state, "mounts"), `${home}/projects/dogchef/dev/apps \n`);
  for (const [n, src] of [["dev-projects", O], ["dev-orca", `${home}/orca`], ["dev-m-p-dogchef", `${O}/dogchef`]])
    writeFileSync(join(state, `d-${n}`), `source: ${src}\n`);

  // before the window: the wrapper dir, devbox the old one-liner to dev, a dogchefbox link left from the two-name box
  sh(`install -m 644 ${nucbox}/is-business-dir.sh ${home}/.local/claude-wrap/ && ln -s ${home}/.local/claude-wrap/box ${home}/.local/bin/dogchefbox`);
  w(".local/bin/devbox", "#!/bin/sh\nexec lxc exec dev --cwd \"$PWD\" -- sudo -u fabio -H bash -lc 'cd \"$0\" && exec \"$@\"' \"$PWD\" \"$@\"\n");
  spawnSync("chmod", ["+x", join(home, ".local/bin/devbox")]);

  // git: a repo with a linked worktree under orca, and a dogchef-origin workspace
  const g = `git -c user.email=t@t -c user.name=t`;
  mk("Projects/personal/evcc-pi");
  sh(`git init -q . && ${g} commit -q --allow-empty -m i && git worktree add -q ${home}/orca/workspaces/factory/wt`, join(home, "Projects/personal/evcc-pi"));
  mk("orca/workspaces/dev/SUP-1");
  sh(`git init -q . && git remote add origin ssh://git@github.com/dogchef-be/dev.git`, join(home, "orca/workspaces/dev/SUP-1"));

  // claude state
  const key = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
  mk(`.claude/projects/${key(O)}-personal-evcc-pi/memory`); w(`.claude/projects/${key(O)}-personal-evcc-pi/memory/MEMORY.md`, "m");
  mk(`.claude-business/projects/${key(O)}-dogchef-dev`);
  w(".claude/settings.json", JSON.stringify({ extraKnownMarketplaces: { factory: { source: { path: `${O}/personal/factory` } } } }));
  symlinkSync("../.claude/settings.json", join(home, ".claude-business/settings.json"));
  w(".claude.json", JSON.stringify({ projects: { [`${O}/personal/evcc-pi`]: { allowedTools: [] } } }));
  w(".claude-business/.claude.json", JSON.stringify({ projects: { [`${O}/dogchef`]: {} } }));
  w(".claude/plugins/known_marketplaces.json", JSON.stringify({ factory: { path: `${O}/personal/factory`, installLocation: `${O}/personal/factory` } }));
  const hist = (p, d) => JSON.stringify({ display: `look at ${O}/x`, project: p, d }) + "\n";
  w(".claude/history.jsonl", hist(`${O}/personal/evcc-pi`, 1) + hist(`/elsewhere`, 2));
  w(".claude-business/history.jsonl", hist(`${O}/dogchef/dev`, 3));
  // the block as claude-devbox.md has it, under the old path: only the paths change
  w(".claude/CLAUDE.md", `# graphify\nkeep\n\n${devboxMd.replaceAll("~/projects", "~/Projects")}\n# No Claude attribution\nkeep too ~/Projects/x\n`);
  w("Projects/dogchef/handoffs/dev.md", "run devbox make start in ~/Projects/dogchef/dev\n");
  w("Projects/dogchef/handoffs/old.md", "dogchefbox make stop\n");
  w("Projects/dogchef/handoffs/odd.md", `see \`${O}/dogchef\` and (${O}/ffv0) and $HOME/Projects/oss, ~/Projects.\nLinear Projects stay; ${O}/dogchef/x.md\n`);
  mk(".factory/tasks/p/u1/r-open"); mk(".factory/tasks/p/u1/r-done");
  w(".factory/tasks/p/u1/r-open/task.md", `# T\nFolder: ${O}/personal/evcc-pi (read only)\nStatus: fix\nContext: ${O}/personal/evcc-pi stays\n`);
  w(".factory/tasks/p/u1/r-done/task.md", `Folder: ${O}/personal/evcc-pi\nStatus: done\n`);
  mk(".factory/tasks/p/u1/r-nostatus"); mk(".factory/tasks/p/u1/r-stopped");
  w(".factory/tasks/p/u1/r-nostatus/task.md", `Folder: ${O}/personal/evcc-pi\n`);
  w(".factory/tasks/p/u1/r-stopped/task.md", `Folder: ${O}/personal/evcc-pi\nStatus: Stopped by the user\n`);
  mk(".factory/tasks/p/u1/r-two");
  w(".factory/tasks/p/u1/r-two/task.md", `Folder: ${O}/personal/evcc-pi (main); also ${O}/dogchef/dev (read only)\nStatus: blocked\n`);

  // Orca registry: one row names the old path, content_hash is the sha256 of the payload
  const db = join(home, ".config/orca/profiles/local-default/profile-state.db");
  const py = `import sqlite3,hashlib,sys
c=sqlite3.connect(sys.argv[1]);c.execute("create table profile_state_documents (domain text primary key, payload text not null, domain_version integer, revision integer, updated_at integer, content_hash text not null)")
for d,p in (("repos",'{"path":"'+sys.argv[2]+'/personal/evcc-pi"}'),("ui","{}")):
  c.execute("insert into profile_state_documents values (?,?,1,1,0,?)",(d,p,hashlib.sha256(p.encode()).hexdigest()))
c.commit()`;
  const r = spawnSync("python3", ["-I", "-c", py, db, O]); assert.equal(r.status, 0, String(r.stderr));

  const env = { ...process.env, HOME: home, STUB_STATE: state, PROC_DIR: join(home, "proc"),
    PATH: `${join(home, ".local/bin")}:${join(home, "bin")}:${process.env.PATH}` };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|ORCA_.*|PROJECTS_DIR|RENAME_START_PID)$/.test(k)) delete env[k];
  const run = (args, extra = {}, s = script) => spawnSync("bash", [s, ...args], { cwd: home, encoding: "utf8", env: { ...env, ...extra } });
  const calls = () => (existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8").trim().split("\n") : []);
  const read = (p) => readFileSync(join(home, p), "utf8");
  return { home, state, O, db, key, run, calls, read, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("dry-run prints the steps and changes nothing", () => {
  const t = setup();
  try {
    const r = t.run(["--dry-run", "--no-slots"]);
    assert.equal(r.status, 0, r.stderr);
    for (const s of ["[1] stop Orca", "[3] stop the dev stack", "[4] mv", "[13] Orca registry"]) assert.ok(r.stdout.includes(s), s);
    assert.match(r.stdout, /\+ mv .*Projects .*projects/);
    assert.ok(lstatSync(t.O).isDirectory() && !lstatSync(t.O).isSymbolicLink());
    assert.ok(!existsSync(join(t.home, "projects")) && !existsSync(join(t.home, "backup-projects-rename")));
    assert.deepEqual(t.calls().filter((l) => /^(stop|start|config device (add|remove)|exec)|systemctl --user (stop|start)/.test(l)), []);
    assert.match(t.read(".claude/settings.json"), /Projects/);
    assert.match(r.stdout, /dev\.md:1:run devbox make start/, "dry-run shows the handoff lines it would change");
    assert.match(r.stdout, /old\.md:1:dogchefbox make stop/, "and the dogchefbox hits");
    assert.match(r.stdout, /lines whose old path changes:\n\d+:.*~\/Projects\/dogchef/, "and the CLAUDE.md lines whose path changes");
    assert.match(r.stdout, /block matches claude-devbox\.md after the path rewrite/);
    assert.match(r.stdout, /r-open\/task\.md:2:Folder: .*evcc-pi.*Status: fix/, "and the task folders with their Status");
    assert.doesNotMatch(r.stdout, /r-(nostatus|stopped|done)\/task\.md/, "only records with an open Status");
    assert.match(r.stdout, /cloud-init status/, "and the cloud-init wait");
  } finally { t.done(); }
});

test("a live run does every step, and a second run changes nothing", () => {
  const t = setup();
  try {
    const slot = join(t.home, "orca/workspaces/dev/SUP-1");
    const r = t.run(["--slot", slot]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const N = join(t.home, "projects");
    assert.ok(lstatSync(N).isDirectory() && lstatSync(t.O).isSymbolicLink() && readlinkSync(t.O) === "projects");
    assert.ok(existsSync(join(t.home, "backup-projects-rename", ".done")));

    // git: the linked worktree and the main repo agree on the new path
    const wt = join(t.home, "orca/workspaces/factory/wt");
    assert.equal(sh("git status --porcelain && git rev-parse --git-common-dir", wt).status, 0);
    assert.match(readFileSync(join(wt, ".git"), "utf8"), new RegExp(`${N}/personal/evcc-pi`));
    assert.doesNotMatch(sh("git worktree list --porcelain", join(N, "personal/evcc-pi")).stdout, /prunable/);

    // claude state
    assert.ok(existsSync(join(t.home, ".claude/projects", t.key(N) + "-personal-evcc-pi/memory/MEMORY.md")));
    assert.ok(existsSync(join(t.home, ".claude-business/projects", t.key(N) + "-dogchef-dev")));
    assert.ok(!existsSync(join(t.home, ".claude/projects", t.key(t.O) + "-personal-evcc-pi")));
    assert.ok(lstatSync(join(t.home, ".claude-business/settings.json")).isSymbolicLink(), "business settings.json stays a symlink");
    assert.equal(JSON.parse(t.read(".claude/settings.json")).extraKnownMarketplaces.factory.source.path, `${N}/personal/factory`);
    assert.ok(`${N}/personal/evcc-pi` in JSON.parse(t.read(".claude.json")).projects);
    assert.ok(`${N}/dogchef` in JSON.parse(t.read(".claude-business/.claude.json")).projects);
    const h = t.read(".claude/history.jsonl").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(h.map((e) => e.project), [`${N}/personal/evcc-pi`, "/elsewhere"]);
    assert.equal(h[0].display, `look at ${t.O}/x`, "only the project field is rewritten");

    // LXD
    const dev = readFileSync(join(t.state, "calls"), "utf8");
    assert.deepEqual(sh(`ls ${t.state} | sed -n 's/^d-dev-//p'`).stdout.trim().split("\n").sort(), ["m-o-dev", "m-p-dogchef"]);
    assert.match(readFileSync(join(t.state, "d-dev-m-p-dogchef"), "utf8"), new RegExp(`source: ${N}/dogchef`));
    assert.deepEqual(t.calls().filter((l) => /(^| )personal( |$)/.test(l)), [], "nothing names a personal container");
    assert.ok(dev.indexOf("stop dev") < dev.indexOf("config device remove dev projects") && dev.indexOf("config device remove dev projects") < dev.indexOf("start dev"));
    assert.ok(dev.includes(`exec dev -- install -d -o fabio -g fabio -m 755 ${N} ${t.home}/orca ${t.home}/orca/workspaces`));
    assert.match(dev, /exec dev --cwd .*Projects\/dogchef\/dev -- sudo -u fabio -H bash -lc .* make stop/);
    assert.match(dev, /exec dev --cwd .*projects\/dogchef\/dev -- sudo -u fabio -H bash -lc .* make start/);
    assert.match(dev, new RegExp(`slot.sh ensure ${slot}`));

    // CLAUDE.md, handoffs, devbox, Orca
    const md = t.read(".claude/CLAUDE.md");
    assert.equal(md, `# graphify\nkeep\n\n${devboxMd}\n# No Claude attribution\nkeep too ~/projects/x\n`);
    assert.equal(t.read("projects/dogchef/handoffs/dev.md"), "run devbox make start in ~/projects/dogchef/dev\n");
    assert.equal(t.read("projects/dogchef/handoffs/old.md"), "devbox make stop\n");
    assert.equal(t.read("projects/dogchef/handoffs/odd.md"), `see \`${N}/dogchef\` and (${N}/ffv0) and $HOME/projects/oss, ~/projects.\nLinear Projects stay; ${N}/dogchef/x.md\n`);
    assert.equal(t.read(".factory/tasks/p/u1/r-open/task.md"), `# T\nFolder: ${N}/personal/evcc-pi (read only)\nStatus: fix\nContext: ${t.O}/personal/evcc-pi stays\n`);
    const two = `Folder: ${N}/personal/evcc-pi (main); also ${N}/dogchef/dev (read only)\nStatus: blocked\n`;
    assert.equal(t.read(".factory/tasks/p/u1/r-two/task.md"), two, "every old path on a Folder: line");
    assert.match(t.read(".factory/tasks/p/u1/r-done/task.md"), /Projects/, "a done record is left alone");
    assert.match(t.read(".factory/tasks/p/u1/r-nostatus/task.md"), /Projects/, "a record without Status is history");
    assert.match(t.read(".factory/tasks/p/u1/r-stopped/task.md"), /Projects/, "a stopped record is left alone");
    for (const r of ["r-nostatus", "r-stopped", "r-done"])
      assert.ok(!existsSync(join(t.home, "backup-projects-rename", t.home, `.factory/tasks/p/u1/${r}`)), `${r} is not backed up`);
    assert.match(readFileSync(join(t.home, "backup-projects-rename", t.home, ".factory/tasks/p/u1/r-open/task.md"), "utf8"), /Folder: .*Projects/);
    assert.match(readFileSync(join(t.home, "backup-projects-rename/volmounts-before.txt"), "utf8"), /dev_mysql:\/var\/lib\/mysql/);
    assert.equal(readlinkSync(join(t.home, ".local/bin/devbox")), join(t.home, ".local/claude-wrap/box"));
    assert.throws(() => lstatSync(join(t.home, ".local/bin/dogchefbox")), "dogchefbox is gone");
    assert.match(readFileSync(join(t.home, "backup-projects-rename", t.home, ".local/bin/devbox"), "utf8"), /lxc exec dev/, "the old one-liner is backed up");
    const rows = spawnSync("python3", ["-I", "-c", "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select payload,content_hash from profile_state_documents where domain=\"repos\"').fetchone())", t.db], { encoding: "utf8" }).stdout;
    const payload = `{"path":"${N}/personal/evcc-pi"}`;
    assert.ok(rows.includes(payload) && rows.includes(sha(payload)), rows);
    assert.ok(t.calls().includes("systemctl --user start orca.service"));

    // idempotent: nothing mutates the second time
    rmSync(join(t.state, "calls"));
    const r2 = t.run(["--slot", slot]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.deepEqual(t.calls().filter((l) => /^config device (add|remove)/.test(l)), []);
    assert.equal(t.read(".claude/CLAUDE.md"), md);
    assert.equal(t.read(".factory/tasks/p/u1/r-two/task.md"), two);
    assert.match(r2.stdout, /already renamed/);
  } finally { t.done(); }
});

test("refuses: no slot decision, cwd inside Projects, a Claude session, a Claude parent, a running claude", () => {
  const t = setup();
  try {
    let r = t.run([]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /--slot .*--no-slots/);
    r = spawnSync("bash", [script, "--no-slots"], { cwd: join(t.O, "dogchef"), encoding: "utf8", env: { ...process.env, HOME: t.home, PATH: process.env.PATH, PROC_DIR: join(t.home, "proc"), STUB_STATE: t.state } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /cwd is inside/);
    r = t.run(["--no-slots"], { CLAUDECODE: "1" });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /Claude Code session/);
    r = t.run(["--no-slots"], { ORCA_PTY_ID: "x" });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /Orca terminal/);
    mkdirSync(join(t.home, "proc/500"), { recursive: true });
    writeFileSync(join(t.home, "proc/500/status"), "PPid:\t1\n");
    writeFileSync(join(t.home, "proc/500/cmdline"), "claude\0--resume\0");
    r = t.run(["--no-slots"], { RENAME_START_PID: "500" });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /parent process is Claude or Orca/);
    writeFileSync(join(t.state, "claude-running"), "");
    r = t.run(["--no-slots"]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /claude process is running/);
    assert.ok(!existsSync(join(t.home, "projects")), "nothing was moved");
    r = t.run(["--dry-run", "--no-slots"], { CLAUDECODE: "1" });
    assert.equal(r.status, 0); assert.match(r.stdout, /a live run would refuse/);
  } finally { t.done(); }
});

test("the first failure stops the run with its rollback and leaves the later steps undone", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "fail-start"), "");
    const r = t.run(["--no-slots"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /FAILED at step \[\d+\] LXD disks/);
    assert.match(r.stderr, /Rollback for this step: lxc config device add/);
    assert.equal(readlinkSync(join(t.home, ".local/bin/devbox")), join(t.home, ".local/claude-wrap/box"), "devbox is box from step 7 on");
    assert.match(t.read(".claude/CLAUDE.md"), /~\/Projects/);
    // after the cause is fixed the same command finishes
    rmSync(join(t.state, "fail-start"));
    const r2 = t.run(["--no-slots"]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.ok(lstatSync(join(t.home, ".local/bin/devbox")).isSymbolicLink());
  } finally { t.done(); }
});

test("a re-run on another day keeps the first backup, the before-state included", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "fail-start"), "");
    assert.notEqual(t.run(["--no-slots"]).status, 0);
    const bk = join(t.home, "backup-projects-rename");
    const before = readFileSync(join(bk, "git-links.tsv"), "utf8");
    assert.match(before, /Projects/);
    rmSync(join(t.state, "fail-start"));
    mkdirSync(join(t.home, "bin2"));
    writeFileSync(join(t.home, "bin2/date"), "#!/bin/sh\necho 2099-01-01\n", { mode: 0o755 });
    const r = t.run(["--no-slots"], { PATH: `${join(t.home, "bin2")}:${join(t.home, ".local/bin")}:${join(t.home, "bin")}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(bk, "git-links.tsv"), "utf8"), before);
    assert.equal(sh(`ls -d ${t.home}/backup-projects-rename*`).stdout.trim(), bk);
  } finally { t.done(); }
});

test("no backup is taken once the old path is already a symlink and no backup is complete", () => {
  const t = setup();
  try {
    sh(`mv ${t.O} ${t.home}/projects && ln -s projects ${t.O}`);
    const r = t.run(["--no-slots"]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /no complete backup/);
    assert.match(r.stderr, /Rollback for this step: .*systemctl --user start orca\.service/, "Orca was stopped in step 1");
  } finally { t.done(); }
});

test("a docker volume that is not mounted again stops the run at the recreate step", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "volmounts-after"), "/dev-mysql dev_mysql_new:/var/lib/mysql \n");
    const r = t.run(["--no-slots"]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /FAILED at step \[\d+\] recreate the dev stack/);
    assert.match(r.stderr, /verify FAILED: .*same volumes/);
  } finally { t.done(); }
});

test("a duplicate key after the path rewrite restores the file and prints the rollback", () => {
  const t = setup();
  try {
    const n = join(t.home, "projects");
    const orig = JSON.stringify({ projects: { [`${t.O}/dogchef`]: {}, [`${n}/dogchef`]: {} } });
    writeFileSync(join(t.home, ".claude-business/.claude.json"), orig.replace(/^/, ""));
    const r = t.run(["--no-slots"]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /duplicate/); assert.match(r.stderr, /Rollback for this step: restore/);
    assert.equal(t.read(".claude-business/.claude.json"), orig);
  } finally { t.done(); }
});

test("only the symlink is made when a failed run left projects without it", () => {
  const t = setup();
  try {
    const bk = join(t.home, "bk"); mkdirSync(bk); writeFileSync(join(bk, ".done"), ""); writeFileSync(join(bk, "git-health.txt"), "prunable=0 broken=0\n"); writeFileSync(join(bk, "volmounts-before.txt"), "");
    sh(`mv ${t.O} ${t.home}/projects`);
    const r = t.run(["--no-slots"], { BACKUP_DIR: bk });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readlinkSync(t.O), "projects");
  } finally { t.done(); }
});

test("a backup with only slot replicas running succeeds (the stack is down after a reboot)", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "volmounts"), "/dev-apps-sup-1 dev-npm-cache:/home/dogchef/.npm \n");
    writeFileSync(join(t.state, "volmounts-after"), "");
    const r = t.run(["--no-slots"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(t.home, "backup-projects-rename/volmounts-before.txt"), "utf8"), "");
  } finally { t.done(); }
});

test("a container whose volumes come back in another order passes the mount check", () => {
  const t = setup();
  try {
    writeFileSync(join(t.state, "volmounts"), "/dev-mysql dev_mysql:/var/lib/mysql dev_logs:/var/log/mysql \n");
    writeFileSync(join(t.state, "volmounts-after"), "/dev-mysql dev_logs:/var/log/mysql dev_mysql:/var/lib/mysql \n");
    const r = t.run(["--no-slots"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { t.done(); }
});

test("a CLAUDE.md block that differs from claude-devbox.md beyond paths is swapped for it, the rest kept", () => {
  const t = setup();
  try {
    writeFileSync(join(t.home, ".claude/CLAUDE.md"), "# graphify\nkeep\n\n# dogchef-be repos run inside the `dev` LXD container\n`~/Projects` is mounted there.\n\n# No Claude attribution\nkeep too\n");
    const d = t.run(["--dry-run", "--no-slots"]);
    assert.match(d.stdout, /block differs from claude-devbox\.md.*swapped/);
    assert.equal(t.run(["--no-slots"]).status, 0);
    assert.equal(t.read(".claude/CLAUDE.md"), `# graphify\nkeep\n\n${devboxMd}\n# No Claude attribution\nkeep too\n`);
  } finally { t.done(); }
});

test("a dry-run of the script inside the old ~/Projects reads its files there (the new path does not exist yet)", () => {
  const t = setup();
  try {
    const copy = join(t.O, "personal/evcc-pi/nucbox");
    sh(`cp -r ${nucbox}/. ${copy}/`);
    const r = spawnSync("bash", [join(copy, "rename-projects.sh"), "--dry-run", "--no-slots"], { cwd: t.home, encoding: "utf8", env: { ...process.env, HOME: t.home, STUB_STATE: t.state, PROC_DIR: join(t.home, "proc"), PATH: `${join(t.home, ".local/bin")}:${join(t.home, "bin")}:${process.env.PATH}`, CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /block matches claude-devbox\.md after the path rewrite/);
  } finally { t.done(); }
});

test("a live run of the script inside the old ~/Projects passes every pre-mv step (the new path does not exist yet)", () => {
  const t = setup();
  try {
    const copy = join(t.O, "personal/evcc-pi/nucbox");
    sh(`cp -r ${nucbox}/. ${copy}/`);
    const r = t.run(["--no-slots"], {}, join(copy, "rename-projects.sh"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(lstatSync(join(t.home, "projects")).isDirectory() && !lstatSync(join(t.home, "projects")).isSymbolicLink());
    assert.equal(readlinkSync(join(t.home, ".local/bin/devbox")), join(t.home, ".local/claude-wrap/box"));
  } finally { t.done(); }
});
