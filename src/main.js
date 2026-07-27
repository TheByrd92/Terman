'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('@lydell/node-pty');
const { Settings } = require('./settings');
const { SshAgent } = require('./ssh-agent');

const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
const DEV = process.argv.includes('--dev');
const debug = (...a) => { if (DEV) console.log(...a); };

let sshAgent = null;

/** id -> { proc, profileName, exe, alive } */
const sessions = new Map();
let nextId = 1;
let win = null;
/** Populated after each hotkey (re)registration so the UI can warn about conflicts. */
let hotkeyStatus = { newDefault: null, pickExe: null, enabled: true };

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 520,
    minHeight: 320,
    backgroundColor: '#12131a',
    title: 'Terman',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
    // Electron >=33 passes a details object; older versions used positional args.
    win.webContents.on('console-message', (a, b, c, d, e) => {
      const d0 = (a && typeof a === 'object' && 'message' in a) ? a : null;
      const msg = d0 ? d0.message : c;
      const level = d0 ? d0.level : ['debug', 'info', 'warn', 'error'][b] || b;
      const src = d0 ? `${d0.sourceId}:${d0.lineNumber}` : `${e}:${d}`;
      console.log(`[renderer:${level}] ${msg}  (${src})`);
    });
  }

  // F12 toggles devtools regardless of how the app was launched.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('closed', () => {
    win = null;
    for (const id of [...sessions.keys()]) killSession(id);
  });

  // Open target=_blank / clicked links in the real browser, not a child window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function focusWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
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
 * (used by the pick-an-exe hotkey).
 */
function createSession(spec = {}) {
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

  const proc = pty.spawn(exe, args, { name: 'xterm-256color', cols, rows, cwd, env });
  const id = nextId++;
  debug(`[terman] spawn id=${id} exe=${exe} cwd=${cwd} spec=${JSON.stringify(spec)}`);
  const name = spec.exe ? path.basename(exe) : (profile ? profile.name : path.basename(exe));

  sessions.set(id, { proc, profileName: name, exe, alive: true });

  proc.onData((data) => send('pty:data', id, data));
  proc.onExit(({ exitCode, signal }) => {
    const s = sessions.get(id);
    if (s) s.alive = false;
    send('pty:exit', id, exitCode, signal);
  });

  return { id, name, exe, cwd };
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.proc.kill(); } catch { /* already gone */ }
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
    send('hotkey:status', hotkeyStatus);
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

  bind(hotkeys.newDefault, 'newDefault', () => {
    focusWindow();
    send('shortcut:new-default');
  });
  bind(hotkeys.pickExe, 'pickExe', () => {
    focusWindow();
    send('shortcut:pick-exe');
  });

  debug(`[terman] hotkeys ${JSON.stringify({ ...hotkeyStatus, accels: hotkeys })}`);
  send('hotkey:status', hotkeyStatus);
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

  return data;
});

ipcMain.handle('settings:reveal', () => {
  shell.showItemInFolder(settings.file);
  return settings.file;
});

ipcMain.handle('settings:path', () => settings.file);

ipcMain.handle('pty:create', (_e, spec) => {
  try {
    return { ok: true, ...createSession(spec) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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

ipcMain.on('pty:kill', (_e, id) => killSession(id));

/** Ctrl+Shift+` — browse for an exe, rooted at the configured folder. */
ipcMain.handle('dialog:pick-exe', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
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

ipcMain.handle('dialog:pick-folder', async (_e, defaultPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Pick a folder',
    defaultPath: defaultPath || settings.data.pickerRoot,
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

ipcMain.handle('dialog:confirm', async (_e, { title, message, detail }) => {
  const { response } = await dialog.showMessageBox(win, {
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);

  app.whenReady().then(() => {
    settings.load();
    startSshAgent();
    createWindow();
    registerHotkeys();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    // Drops the decrypted key from memory. Only kills an agent we started.
    if (sshAgent) sshAgent.stop();
  });
}
