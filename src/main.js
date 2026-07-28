'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { Settings } = require('./settings');
const { SshAgent } = require('./ssh-agent');
const tmux = require('./tmux');

/**
 * node-pty ships a native binary, so `asarUnpack` keeps it outside app.asar -- which
 * makes it the first thing to go missing when an install is incomplete (a half-deleted
 * portable extraction, an interrupted copy, an antivirus quarantine). Left alone, that
 * surfaces as a raw module-resolution stack naming a package.json nobody has heard of.
 * Name the real problem instead, and say how to fix it.
 */
let pty;
try {
  pty = require('@lydell/node-pty');
} catch (err) {
  dialog.showErrorBox('Terman is missing files', [
    'Could not load the terminal backend (@lydell/node-pty).',
    '',
    'This copy of Terman looks incomplete:',
    path.dirname(app.getPath('exe')),
    '',
    'Reinstall Terman. If you are running the portable build, close every Terman',
    'process first, then delete its folder under %TEMP% so it re-extracts cleanly.',
    '',
    `Details: ${err.message}`,
  ].join('\n'));
  app.exit(1);
}

const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
const DEV = process.argv.includes('--dev');
const debug = (...a) => { if (DEV) console.log(...a); };

// ---------------------------------------------------------------- crash handling

let crashing = false;

/**
 * Electron's default reaction to an uncaught main-process exception is a modal that
 * leaves the process alive behind it. For an app that spawns shells that is the worst
 * option available: the terminals it started keep running, and each parked instance
 * holds its own files open, so one crash quietly becomes a pile of orphaned Terman
 * processes. Take the handler over so a crash takes its children down and exits.
 */
function installCrashHandlers() {
  // Electron's dialog is itself an 'uncaughtException' listener, and a listener is
  // what suppresses Node's default exit -- dropping it is how we get to decide.
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');

  const die = (kind) => (err) => {
    if (crashing) return;  // a failure inside the teardown must not recurse
    crashing = true;
    const detail = (err && err.stack) || String(err);
    console.error(`[terman] ${kind}: ${detail}`);
    try { killEverything(); } catch { /* nothing left to try */ }
    try { dialog.showErrorBox(`Terman: ${kind}`, detail); } catch { /* no UI available */ }
    // exit(), not quit(): the teardown quit() would run is the teardown we just did,
    // and a process this broken should not get the chance to hang on the way out.
    app.exit(1);
  };

  process.on('uncaughtException', die('uncaught exception'));
  process.on('unhandledRejection', die('unhandled promise rejection'));
}

installCrashHandlers();

let sshAgent = null;

/** id -> { proc, profileName, exe, alive, wc } -- wc is the window owning the tab */
const sessions = new Map();
let nextId = 1;
/** Populated after each hotkey (re)registration so the UI can warn about conflicts. */
let hotkeyStatus = { newDefault: null, pickExe: null, enabled: true };

/**
 * Every open window. They deliberately share one process: that way there is a single
 * ssh-agent (so you unlock once, not once per window), one owner of the global
 * hotkeys, and one writer for settings.json. The single-instance lock stays for the
 * same reason -- launching the exe again asks this process for another window.
 */
const windows = new Set();
/** Last window to take focus, so a hotkey pressed elsewhere in the OS has a target. */
let lastFocused = null;

// ---------------------------------------------------------------- window

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 520,
    minHeight: 320,
    backgroundColor: '#12131a',
    title: `Terman ${app.getVersion()}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const wc = win.webContents;
  windows.add(win);
  lastFocused = win;

  // The page's own <title> would otherwise replace the version in the title bar.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (DEV) {
    wc.openDevTools({ mode: 'detach' });
    // Electron >=33 passes a details object; older versions used positional args.
    wc.on('console-message', (a, b, c, d, e) => {
      const d0 = (a && typeof a === 'object' && 'message' in a) ? a : null;
      const msg = d0 ? d0.message : c;
      const level = d0 ? d0.level : ['debug', 'info', 'warn', 'error'][b] || b;
      const src = d0 ? `${d0.sourceId}:${d0.lineNumber}` : `${e}:${d}`;
      console.log(`[renderer:${level}] ${msg}  (${src})`);
    });
  }

  // F12 toggles devtools regardless of how the app was launched.
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') wc.toggleDevTools();
  });

  win.on('focus', () => { lastFocused = win; });

  win.on('closed', () => {
    windows.delete(win);
    if (lastFocused === win) lastFocused = null;
    // This window's terminals only -- other windows keep theirs.
    for (const [id, s] of [...sessions]) {
      if (s.wc === wc) killSession(id);
    }
  });

  // Open target=_blank / clicked links in the real browser, not a child window.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  debug(`[terman] window opened (${windows.size} open)`);
  return win;
}

/**
 * Where a global hotkey should act: the focused window, else the last one focused,
 * else a new one. Without the fallback, a hotkey pressed while another app has focus
 * would have nowhere to go.
 */
function summonWindow() {
  let win = BrowserWindow.getFocusedWindow();
  if (!win || !windows.has(win)) win = lastFocused;
  if (!win || win.isDestroyed()) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

function sendTo(wc, channel, ...args) {
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
}

/** Deliver once the renderer exists to receive it -- a just-created window is still
 *  loading, and a message sent now would go nowhere. */
function sendWhenReady(win, channel, ...args) {
  const wc = win.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => sendTo(wc, channel, ...args));
  else sendTo(wc, channel, ...args);
}

function broadcast(channel, ...args) {
  for (const win of windows) sendTo(win.webContents, channel, ...args);
}

/** The window that sent an IPC message, for parenting its dialogs. */
function senderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || lastFocused;
}

// ---------------------------------------------------------------- pty

/**
 * Most specific wins: an explicit request, then the profile's own folder, then the
 * global default, then home. Each candidate must actually be a directory, so a stale
 * path in settings falls through instead of failing the spawn.
 */
function resolveCwd(requested, profile) {
  const candidates = [requested, profile && profile.cwd, settings.data.defaultCwd, os.homedir()];
  for (const c of candidates) {
    if (c && typeof c === 'string') {
      try {
        if (fs.statSync(c).isDirectory()) return c;
      } catch { /* not a usable directory - try next */ }
    }
  }
  return process.cwd();
}

/**
 * Spawn a PTY. `spec` is either { profileId } or an ad-hoc { exe, args, cwd }
 * (used by the pick-an-exe hotkey). `wc` is the window that owns the tab -- its
 * output goes only there, and it dies with that window.
 */
function createSession(spec = {}, wc = null) {
  const profile = spec.profileId ? settings.profile(spec.profileId) : settings.defaultProfile();
  const exe = spec.exe || (profile && profile.exe);
  if (!exe) throw new Error('No shell configured. Open Settings and add a profile.');
  if (!fs.existsSync(exe)) throw new Error(`Not found: ${exe}`);

  const args = spec.exe ? (spec.args || []) : ((profile && profile.args) || []);
  const cwd = resolveCwd(spec.cwd, profile);
  const env = {
    ...process.env,
    ...((!spec.exe && profile && profile.env) || {}),
    // Shared agent, so a passphrase-protected key is unlocked once per launch
    // rather than once per tab. Empty when the agent is off or unavailable.
    ...(sshAgent ? sshAgent.env() : {}),
    TERM: 'xterm-256color',
  };

  // Electron leaks these into children and they confuse some shells.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const cols = Math.max(2, Number(spec.cols) || 80);
  const rows = Math.max(2, Number(spec.rows) || 24);

  // A tmux-backed profile spawns a tmux client instead of the shell itself, so the work
  // outlives this process. Never for an ad-hoc exe pick -- that's "run this one thing",
  // not a session worth keeping. A profile that can't reach a tmux falls through and
  // spawns normally rather than failing the tab.
  let spawnExe = exe;
  let spawnArgs = args;
  let tmuxSession = null;
  let resumed = false;
  if (!spec.exe && profile && profile.tmux && profile.tmux.enabled) {
    const wrapped = tmux.wrap(profile);
    if (wrapped) {
      spawnExe = wrapped.exe;
      spawnArgs = wrapped.args;
      tmuxSession = wrapped.session;
      resumed = wrapped.resumed;
      debug(`[terman] tmux ${resumed ? 'resume' : 'new'} session=${tmuxSession}`);
    } else {
      console.error(`[terman] profile ${profile.id} has tmux on but cannot run it; spawning directly`);
    }
  }

  const proc = pty.spawn(spawnExe, spawnArgs, { name: 'xterm-256color', cols, rows, cwd, env });
  const id = nextId++;
  debug(`[terman] spawn id=${id} exe=${spawnExe} cwd=${cwd} spec=${JSON.stringify(spec)}`);
  const name = spec.exe ? path.basename(exe) : (profile ? profile.name : path.basename(exe));

  sessions.set(id, {
    proc, profileName: name, exe, alive: true, wc,
    // Kept so an explicit close can take the tmux session down with the tab.
    profileId: profile ? profile.id : null,
    tmuxSession,
  });

  proc.onData((data) => sendTo(wc, 'pty:data', id, data));
  proc.onExit(({ exitCode, signal }) => {
    const s = sessions.get(id);
    if (s) s.alive = false;
    sendTo(wc, 'pty:exit', id, exitCode, signal);
  });

  return { id, name, exe, cwd, tmuxSession, resumed };
}

/**
 * Kill a process and everything under it. `pty.kill()` only ends the shell Terman
 * started -- whatever that shell launched (a build, an ssh, a nested shell) gets
 * reparented and survives. On Windows `taskkill /T` is the only reliable way to take
 * a whole tree down, and it's what keeps a crash from leaving work running with no
 * window attached to it.
 */
function killTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } else {
      process.kill(-n, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

/**
 * `killTmux` is the difference between "the user closed this tab" and "Terman is going
 * away". Closing a tab takes its tmux session with it, or the session would linger with
 * nothing pointing at it. Quitting and crashing deliberately leave it running -- that is
 * the entire point of a tmux-backed tab, and it's what the next launch reattaches to.
 */
function killSession(id, { killTmux = false } = {}) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);

  // Server-side first: kill-session ends everything inside the session cleanly, where
  // killing the client would only take the viewport and leave the work running with
  // nothing attached to it.
  if (killTmux && s.tmuxSession) {
    const profile = s.profileId ? settings.profile(s.profileId) : null;
    if (profile) tmux.killSession(profile, s.tmuxSession);
  }

  // Only chase the tree while the shell is known to be running. Once node-pty has
  // reported the exit that pid is fair game for reuse, and taskkill doesn't ask
  // whether the pid it was handed still means what we think it means.
  if (s.alive) killTree(s.proc.pid);
  s.alive = false;
  try { s.proc.kill(); } catch { /* already gone */ }
}

/**
 * Everything this process spawned, gone. Called on quit and on crash, and safe to
 * call twice -- the session map empties as it goes.
 */
function killEverything() {
  for (const id of [...sessions.keys()]) killSession(id);

  if (!sshAgent) return;
  // Read these before stop() clears them.
  const { pid: agentPid, adopted } = sshAgent;
  try { sshAgent.stop(); } catch { /* going away anyway */ }
  // stop() asks the agent to exit via `ssh-agent -k`, which needs a live socket -- on
  // a crash that can fail without saying so. An agent we started gets no benefit of
  // the doubt; an adopted one belongs to someone else and is left alone.
  if (!adopted) killTree(agentPid);
  sshAgent = null;
}

/**
 * Clear out Terman-owned tmux sessions that have nothing left in them.
 *
 * Quitting leaves sessions running on purpose so the next launch can resume them, which
 * means the empty ones would otherwise accumulate for as long as the machine is up. Only
 * sessions Terman created, with no client attached and nothing but an idle shell inside,
 * are reaped -- work you left behind is what this whole feature is for.
 *
 * Deferred off the startup path: each profile costs a `tmux list-sessions`, and the first
 * window should paint before Terman goes looking for housekeeping.
 */
function reapTmuxSessions() {
  setTimeout(() => {
    for (const profile of settings.data.profiles) {
      if (!profile.tmux || !profile.tmux.enabled) continue;
      try {
        const killed = tmux.reap(profile);
        if (killed.length) debug(`[terman] reaped empty tmux sessions: ${killed.join(', ')}`);
      } catch (err) {
        console.error(`[terman] tmux reap failed for ${profile.id}:`, err.message);
      }
    }
  }, 2000);
}

// ---------------------------------------------------------------- hotkeys

/**
 * Global hotkeys are system-wide: while enabled they take the combo away from
 * every other app (VS Code's Ctrl+` being the notable casualty). The renderer
 * also binds the same combos locally, so turning this off just narrows them to
 * "when Terman has focus".
 */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const { hotkeys, globalHotkeys } = settings.data;
  hotkeyStatus = { newDefault: null, pickExe: null, enabled: !!globalHotkeys };

  if (!globalHotkeys) {
    broadcast('hotkey:status', hotkeyStatus);
    return;
  }

  const bind = (accel, key, fn) => {
    if (!accel) return;
    try {
      hotkeyStatus[key] = globalShortcut.register(accel, fn)
        ? 'ok'
        : 'taken'; // another app owns it
    } catch (err) {
      hotkeyStatus[key] = 'invalid';
      console.error(`[terman] bad accelerator ${accel}:`, err.message);
    }
  };

  // Both act on the window the hotkey summoned, not on every window.
  bind(hotkeys.newDefault, 'newDefault', () => {
    sendWhenReady(summonWindow(), 'shortcut:new-default');
  });
  bind(hotkeys.pickExe, 'pickExe', () => {
    sendWhenReady(summonWindow(), 'shortcut:pick-exe');
  });

  debug(`[terman] hotkeys ${JSON.stringify({ ...hotkeyStatus, accels: hotkeys })}`);
  broadcast('hotkey:status', hotkeyStatus);
}

// ---------------------------------------------------------------- ipc

ipcMain.handle('settings:get', () => settings.data);

ipcMain.handle('settings:save', (_e, patch) => {
  const data = settings.save(patch);
  registerHotkeys();

  // Toggling the agent takes effect immediately; existing tabs keep the env they
  // were spawned with, so it applies to new terminals.
  if (data.sshAgent.enabled && !sshAgent) startSshAgent();
  else if (!data.sshAgent.enabled && sshAgent) { sshAgent.stop(); sshAgent = null; }

  // One settings file, several windows: the others would otherwise keep applying
  // the font size and hotkey hints they were opened with.
  broadcast('settings:changed', data);
  return data;
});

ipcMain.handle('settings:reveal', () => {
  shell.showItemInFolder(settings.file);
  return settings.file;
});

ipcMain.handle('settings:path', () => settings.file);

ipcMain.handle('pty:create', (e, spec) => {
  try {
    return { ok: true, ...createSession(spec, e.sender) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('window:new', () => { createWindow(); });

ipcMain.on('pty:write', (_e, id, data) => {
  const s = sessions.get(id);
  if (s && s.alive) {
    try { s.proc.write(data); } catch { /* raced with exit */ }
  }
});

ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  const s = sessions.get(id);
  if (s && s.alive) {
    try { s.proc.resize(Math.max(2, cols | 0), Math.max(2, rows | 0)); } catch { /* raced with exit */ }
  }
});

// The tab's close button. The one path that means "I'm done with this", so it's the one
// path that takes a tmux session down with it.
ipcMain.on('pty:kill', (_e, id) => killSession(id, { killTmux: true }));

/** Ctrl+Shift+` — browse for an exe, rooted at the configured folder. */
ipcMain.handle('dialog:pick-exe', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(senderWindow(e), {
    title: 'Pick a shell / executable',
    defaultPath: settings.data.pickerRoot,
    buttonLabel: 'Open terminal',
    properties: ['openFile'],
    filters: [
      { name: 'Executables', extensions: ['exe', 'cmd', 'bat', 'com'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

ipcMain.handle('dialog:pick-folder', async (e, defaultPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(senderWindow(e), {
    title: 'Pick a folder',
    defaultPath: defaultPath || settings.data.pickerRoot,
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

ipcMain.handle('dialog:confirm', async (e, { title, message, detail }) => {
  const { response } = await dialog.showMessageBox(senderWindow(e), {
    type: 'question',
    buttons: ['Cancel', 'Close anyway'],
    defaultId: 0,
    cancelId: 0,
    title: title || 'Confirm',
    message: message || 'Are you sure?',
    detail,
  });
  return response === 1;
});

ipcMain.handle('hotkey:status', () => hotkeyStatus);

/** Which shells can be tmux-backed, so the settings UI can grey out the rest. */
ipcMain.handle('tmux:shells', () => tmux.SHELL_BASENAMES);

// ---------------------------------------------------------------- ssh agent

function startSshAgent() {
  const cfg = settings.data.sshAgent;
  if (!cfg.enabled) {
    sshAgent = null;
    return;
  }
  sshAgent = new SshAgent(cfg.binDir || null);
  const ok = sshAgent.start();
  debug(`[terman] ssh-agent ${ok ? `up sock=${sshAgent.sock} adopted=${sshAgent.adopted}` : `failed: ${sshAgent.error}`}`);
  if (!ok) sshAgent = null;
}

ipcMain.handle('ssh:status', () => {
  if (!settings.data.sshAgent.enabled) return { enabled: false, running: false, keyCount: 0 };
  if (!sshAgent) return { enabled: true, running: false, keyCount: 0, error: 'agent not started' };
  return { enabled: true, ...sshAgent.status() };
});

/** Returns what the renderer should open in a tab so ssh-add can prompt on a real tty. */
ipcMain.handle('ssh:unlock-spec', () => {
  if (!sshAgent) return null;
  return sshAgent.unlockSpec(settings.data.sshAgent.keys);
});

// ---------------------------------------------------------------- lifecycle

// The lock is kept on purpose, but it now means "one process", not "one window":
// a second launch hands off to this process and gets another window out of it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { createWindow(); });

  app.whenReady().then(() => {
    settings.load();
    startSshAgent();
    Menu.setApplicationMenu(null);
    createWindow();
    registerHotkeys();
    reapTmuxSessions();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    // Terminal trees first, then the agent -- which also drops the decrypted key from
    // memory. Quitting Terman should not leave shells of ours running.
    killEverything();
  });
}
