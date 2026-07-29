'use strict';

/**
 * tmux-backed terminal sessions.
 *
 * The problem it solves: a ConPTY belongs to the process that created it, and its pipes
 * are anonymous. When Terman dies -- crash, kill, restart -- the shell it was hosting
 * loses its console and exits, and a new Terman cannot reattach. Nothing Terman does to
 * its own PTYs can change that.
 *
 * So the shell has to live somewhere else. When a profile is tmux-backed, the PTY holds
 * a tmux *client* and the work lives in the tmux *server*, which daemonizes out of
 * Terman's process tree entirely. Terman dying takes the client; the session keeps
 * running, and the next client attaches straight back onto it.
 *
 * Recovery therefore needs no UI: `new-session -A` attaches if the session exists and
 * creates it otherwise, so reopening a tab on the same profile resumes the same work.
 */

const { spawnSync } = require('child_process');
const path = require('path');

/**
 * Shells that can reach a tmux, by executable basename. Exported because the settings UI
 * greys out the toggle for profiles that can't be wrapped, and it should be asking this
 * module rather than keeping its own copy of the rule.
 */
const POSIX_SHELLS = ['bash', 'sh', 'zsh'];
const WSL = 'wsl.exe';
const SHELL_BASENAMES = [...POSIX_SHELLS, ...POSIX_SHELLS.map((s) => `${s}.exe`), WSL];

/** tmux forbids `:` and `.` in session names (they address windows and panes). */
function sanitizeName(raw) {
  const s = String(raw || '').trim().replace(/[:.\s]+/g, '-').replace(/[^A-Za-z0-9_-]/g, '');
  return s || 'terman';
}

/**
 * How to run a POSIX command line for a given profile.
 *
 * Only shells that can actually reach a tmux qualify. PowerShell and cmd have no tmux to
 * reach, and `ssh` is deliberately excluded: the command has to land after the host
 * argument, whose position varies, and the README already documents writing the tmux
 * invocation into the profile's args by hand.
 *
 * `login` is for the interactive tab, which wants the user's real environment. Management
 * calls pass login=false, because sourcing a login profile costs most of a second and
 * these run while the user waits.
 */
function posixRunner(profile, command, { login = true } = {}) {
  const exe = String((profile && profile.exe) || '');
  const base = path.basename(exe).toLowerCase();
  const args = Array.isArray(profile && profile.args) ? profile.args : [];

  if (POSIX_SHELLS.includes(base.replace(/\.exe$/, ''))) {
    // Keep the profile's own flags (MSYS profiles rely on -l plus CHERE_INVOKING to
    // stay in the cwd they were handed) and append the command.
    const keep = login ? args.filter((a) => a !== '-c') : [];
    return { exe, args: [...keep, '-c', command] };
  }

  if (base === WSL) {
    // Everything before `--` selects the distro; everything after is the command.
    const keep = args.filter((a) => a !== '--');
    return { exe, args: [...keep, '--', 'sh', '-c', command] };
  }

  return null;
}

/** True when this profile can be tmux-backed at all. */
function supports(profile) {
  return !!posixRunner(profile, ':');
}

/**
 * Where tmux lives on both supported runners: MSYS2 ships /usr/bin/tmux, and every
 * distro WSL runs puts it on one of these.
 *
 * Management commands run with login=false, which means /etc/profile never runs and PATH
 * is whatever Electron inherited. Launched from a shortcut that contains no MSYS2 at all,
 * so `tmux` came back "command not found" (exit 127) -- and since run() reports a failure
 * as empty output, listSessions saw an empty server, chooseSession handed out the bare
 * name stem every time, and `new-session -A` attached each new tab to the one session
 * that already existed. That is the bug where every terminal is the same tmux.
 *
 * The interactive tab hid it: that one spawns with -l, so it gets a real PATH.
 * $PATH stays on the end so an unusual install location still resolves.
 */
const TMUX_PATH = '/usr/bin:/usr/local/bin:/bin';

/**
 * Run a tmux management command and return its stdout.
 *
 * Deliberately synchronous: these are short, they gate spawning a tab, and threading a
 * promise through PTY creation buys nothing when the command takes milliseconds. That is
 * also why it can't just use a login shell to fix PATH -- sourcing a login profile costs
 * most of a second, and these run while the user waits for a tab.
 */
function run(profile, tmuxArgs, { timeout = 5000 } = {}) {
  const runner = posixRunner(profile, `PATH="${TMUX_PATH}:$PATH" tmux ${tmuxArgs}`, { login: false });
  if (!runner) return { ok: false, out: '', err: 'profile cannot run tmux' };

  let res;
  try {
    res = spawnSync(runner.exe, runner.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      env: { ...process.env, ...((profile && profile.env) || {}) },
    });
  } catch (err) {
    return { ok: false, out: '', err: err.message };
  }

  const out = (res.stdout || '').trim();
  const err = (res.stderr || '').trim();

  // `no server running` is the normal answer to "what is there" before anything exists,
  // not a failure worth reporting. Anything else is: a management command that fails
  // looks exactly like an empty tmux server to every caller here, and silence is what
  // let "tmux: command not found" masquerade as "no sessions" and put every tab on the
  // same session. If this ever prints, that is the class of bug to suspect.
  if (res.status !== 0 && err && !/no server running/i.test(err)) {
    console.error(`[terman] tmux ${tmuxArgs.split(' ')[0]} failed (${res.status}): ${err}`);
  }

  return { ok: res.status === 0, out, err };
}

const OWNER_OPT = '@terman';
const FIELDS = ['#{session_name}', `#{${OWNER_OPT}}`, '#{session_attached}'].join('\t');

/**
 * Sessions on this profile's tmux server, with whether Terman created them.
 *
 * Ownership is a session option rather than a name prefix so that renaming a session --
 * which is how you rename a tmux-backed tab -- doesn't make Terman lose track of it, and
 * so a session the user made by hand is never mistaken for ours.
 */
function listSessions(profile) {
  const { out } = run(profile, `list-sessions -F '${FIELDS}'`);
  if (!out) return [];
  return out.split(/\r?\n/).map((line) => {
    const [name, owner, attached] = line.split('\t');
    // session_attached is a CLIENT COUNT, not a flag -- a session two clients are
    // mirroring reports "2". Testing it against '1' read that as *unattached*, so
    // chooseSession offered it up as an orphan and every later tab piled another
    // client onto the same screen, which only pushed the count further from '1'.
    const clients = Number(String(attached || '').trim()) || 0;
    return {
      name: (name || '').trim(),
      owned: String(owner || '').trim() === '1',
      clients,
      attached: clients > 0,
    };
  }).filter((s) => s.name);
}

/** Panes per session, so "is anything actually running in there" is answerable. */
function paneCommands(profile) {
  const { out } = run(profile, "list-panes -a -F '#{session_name}\t#{pane_current_command}'");
  const bySession = new Map();
  if (!out) return bySession;
  for (const line of out.split(/\r?\n/)) {
    const [session, cmd] = line.split('\t');
    if (!session) continue;
    if (!bySession.has(session)) bySession.set(session, []);
    bySession.get(session).push(String(cmd || '').trim());
  }
  return bySession;
}

const IDLE_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'tmux', '']);

/**
 * The name every session for this profile is built from -- its numbered variants are
 * `stem`, `stem-2`, `stem-3`. Settings can override it per profile; the profile name is
 * the default.
 */
function sessionStem(profile) {
  return sanitizeName((profile && profile.tmux && profile.tmux.session)
    || (profile && profile.name) || 'terman');
}

/**
 * Whether a session name belongs to this profile.
 *
 * Profiles sharing an MSYS2 installation share one tmux server, so UCRT64, MINGW64 and
 * MSYS all see each other's sessions in `list-sessions`. Only the name stem says which
 * profile a session came from, and reattaching a MINGW64 session under the UCRT64
 * profile would hand it the wrong MSYSTEM.
 */
function ownsName(profile, name) {
  const stem = sessionStem(profile);
  return name === stem || name.startsWith(`${stem}-`);
}

/**
 * Pick the session a new tab on this profile should land on.
 *
 * An owned, unattached session for this profile is work left behind by a previous run,
 * so reuse it -- that is the whole recovery path. Otherwise take the next free number,
 * because two clients on one session would mirror each other's screens rather than give
 * the user a second terminal.
 *
 * `claimed` is the set of sessions this Terman's live tabs are already holding, and it
 * is not redundant with the `attached` check: attachCommand creates the session with
 * `new-session -d` and only then attaches, so between those two steps tmux truthfully
 * reports zero clients. Without `claimed`, a second tab opened inside that window sees
 * a brand-new session as an orphan and adopts it.
 */
function chooseSession(profile, sessions, claimed = new Set()) {
  const stem = sessionStem(profile);

  const mine = sessions.filter((s) => s.owned && !claimed.has(s.name) && ownsName(profile, s.name));
  const resumable = mine.find((s) => !s.attached);
  if (resumable) return { name: resumable.name, resumed: true };

  const taken = new Set([...sessions.map((s) => s.name), ...claimed]);
  if (!taken.has(stem)) return { name: stem, resumed: false };
  for (let i = 2; i < 500; i++) {
    const candidate = `${stem}-${i}`;
    if (!taken.has(candidate)) return { name: candidate, resumed: false };
  }
  return { name: `${stem}-${Date.now?.() || 'x'}`, resumed: false };
}

/**
 * The command a tmux-backed tab runs.
 *
 * `set-titles` is scoped to our own session with `-t`, not set globally: the tab-naming
 * feature needs it on, but Terman has no business rewriting the titles of sessions the
 * user runs outside it. Without this the tab would go *quieter* than an unwrapped one,
 * since tmux swallows the inner program's title and emits nothing of its own.
 */
function attachCommand(session) {
  const s = sanitizeName(session);
  return [
    // Same PATH guard as run(): this one usually spawns a login shell and so finds tmux
    // on its own, but a profile whose args don't include -l would not.
    `export PATH="${TMUX_PATH}:$PATH"`,
    `tmux new-session -d -A -s ${s}`,
    `tmux set-option -t ${s} ${OWNER_OPT} 1`,
    `tmux set-option -t ${s} set-titles on`,
    `tmux set-option -t ${s} set-titles-string '#h: #S (#W)'`,
    `exec tmux attach-session -t ${s}`,
  ].join('; ');
}

/**
 * Rewrite a spawn so it runs inside tmux. Returns null when the profile can't, so the
 * caller falls back to spawning it directly rather than failing the tab.
 *
 * `session` names the session to land on outright, which is how the startup restore
 * reopens a specific piece of left-behind work. Left empty, chooseSession decides.
 */
function wrap(profile, { claimed = new Set(), session = '' } = {}) {
  if (!supports(profile)) return null;

  let name;
  let resumed;
  if (session) {
    name = sanitizeName(session);
    resumed = true;
  } else {
    ({ name, resumed } = chooseSession(profile, listSessions(profile), claimed));
  }

  const runner = posixRunner(profile, attachCommand(name), { login: true });
  if (!runner) return null;

  return { exe: runner.exe, args: runner.args, session: name, resumed };
}

/** Explicit close: the session goes too, or it would linger with no way back to it. */
function killSession(profile, session) {
  if (!session) return false;
  const { ok } = run(profile, `kill-session -t ${sanitizeName(session)}`);
  return ok;
}

/**
 * Terman-owned sessions with nobody attached, split by whether there is real work in
 * them. `busy` is what a previous run left behind and what startup reopens a tab for;
 * `idle` is a bare shell nobody would miss.
 *
 * Both answers come from one pair of tmux calls on purpose: restore and reap disagreeing
 * about a session would mean reaping one while a tab was opening on it.
 */
function orphans(profile, claimed = new Set()) {
  const busy = [];
  const idle = [];

  const candidates = listSessions(profile)
    .filter((s) => s.owned && !s.attached && !claimed.has(s.name));
  if (!candidates.length) return { busy, idle };

  const panes = paneCommands(profile);
  for (const s of candidates) {
    const cmds = panes.get(s.name) || [];
    (cmds.some((c) => !IDLE_COMMANDS.has(c)) ? busy : idle).push(s.name);
  }
  return { busy, idle };
}

/**
 * Drop Terman-owned sessions that have nothing left in them.
 *
 * Quitting Terman deliberately leaves sessions running so the next launch can resume
 * them, which means empty ones would otherwise pile up forever. A session with real work
 * in it is left for the user to come back to -- startup turns those into tabs instead.
 */
function reap(profile, claimed = new Set()) {
  const killed = [];
  for (const name of orphans(profile, claimed).idle) {
    if (killSession(profile, name)) killed.push(name);
  }
  return killed;
}

module.exports = {
  supports,
  wrap,
  listSessions,
  killSession,
  orphans,
  reap,
  sanitizeName,
  sessionStem,
  ownsName,
  posixRunner,
  chooseSession,
  OWNER_OPT,
  SHELL_BASENAMES,
};
