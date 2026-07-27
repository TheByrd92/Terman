'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MSYS_ROOT = 'D:\\Utilities\\msys64';
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

/** Find pwsh.exe without shelling out (spawn is unreliable this early on Win/Node 24). */
function findPwsh() {
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  ];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'pwsh.exe'));
  }
  return candidates.find(exists) || null;
}

/**
 * An MSYS2 shell profile. MSYSTEM selects the toolchain and CHERE_INVOKING
 * keeps `bash -l` in the cwd we hand it instead of jumping to $HOME.
 */
function msysProfile(id, name, msystem, msysRoot) {
  return {
    id,
    name,
    exe: path.join(msysRoot, 'usr', 'bin', 'bash.exe'),
    args: ['-l'],
    cwd: '',
    env: { MSYSTEM: msystem, CHERE_INVOKING: '1' },
  };
}

/** Probe the machine once, on first run, to seed a useful profile list. */
function defaultSettings() {
  const msysRoot = exists(MSYS_ROOT) ? MSYS_ROOT : '';
  const profiles = [];

  if (msysRoot) {
    profiles.push(msysProfile('msys-ucrt64', 'UCRT64', 'UCRT64', msysRoot));
    profiles.push(msysProfile('msys-mingw64', 'MINGW64', 'MINGW64', msysRoot));
    profiles.push(msysProfile('msys-msys', 'MSYS', 'MSYS', msysRoot));
  }

  const pwsh = findPwsh();
  if (pwsh) {
    profiles.push({ id: 'pwsh', name: 'PowerShell 7', exe: pwsh, args: ['-NoLogo'], cwd: '', env: {} });
  }

  const winps = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (exists(winps)) {
    profiles.push({ id: 'winps', name: 'Windows PowerShell', exe: winps, args: ['-NoLogo'], cwd: '', env: {} });
  }

  const cmd = path.join(SYS32, 'cmd.exe');
  if (exists(cmd)) {
    profiles.push({ id: 'cmd', name: 'Command Prompt', exe: cmd, args: [], cwd: '', env: {} });
  }

  // Guarantee at least one profile so the app is never dead on arrival.
  if (profiles.length === 0) {
    profiles.push({ id: 'cmd', name: 'Command Prompt', exe: 'cmd.exe', args: [], cwd: '', env: {} });
  }

  return {
    profiles,
    defaultProfileId: profiles[0].id,
    pickerRoot: msysRoot || SYS32,
    // Folder every new terminal starts in. '' means the user's home directory.
    defaultCwd: '',
    hotkeys: { newDefault: 'Control+`', pickExe: 'Control+Shift+`' },
    globalHotkeys: true,
    // One shared ssh-agent for every tab, so a passphrase-protected key is
    // unlocked once per launch instead of once per terminal. keys: [] means
    // let ssh-add pick its defaults (~/.ssh/id_*).
    sshAgent: { enabled: true, binDir: '', keys: [] },
    fontSize: 14,
    fontFamily: 'Cascadia Mono, Consolas, DejaVu Sans Mono, monospace',
    scrollback: 10000,
    confirmCloseLive: true,
  };
}

/** Coerce whatever is on disk into something the rest of the app can trust. */
function normalize(raw) {
  const d = defaultSettings();
  const s = (raw && typeof raw === 'object') ? { ...raw } : {};

  let profiles = Array.isArray(s.profiles) ? s.profiles : [];
  profiles = profiles
    .filter((p) => p && typeof p === 'object' && typeof p.exe === 'string' && p.exe.trim())
    .map((p, i) => ({
      id: String(p.id || `profile-${i}`),
      name: String(p.name || path.basename(p.exe)),
      exe: String(p.exe),
      args: Array.isArray(p.args) ? p.args.map(String) : [],
      cwd: typeof p.cwd === 'string' ? p.cwd : '',
      env: (p.env && typeof p.env === 'object' && !Array.isArray(p.env)) ? { ...p.env } : {},
    }));
  if (profiles.length === 0) profiles = d.profiles;

  const hk = (s.hotkeys && typeof s.hotkeys === 'object') ? s.hotkeys : {};
  const fontSize = Number(s.fontSize);
  const scrollback = Number(s.scrollback);

  return {
    profiles,
    defaultProfileId: profiles.some((p) => p.id === s.defaultProfileId) ? s.defaultProfileId : profiles[0].id,
    pickerRoot: typeof s.pickerRoot === 'string' && s.pickerRoot ? s.pickerRoot : d.pickerRoot,
    defaultCwd: typeof s.defaultCwd === 'string' ? s.defaultCwd : d.defaultCwd,
    hotkeys: {
      newDefault: typeof hk.newDefault === 'string' ? hk.newDefault : d.hotkeys.newDefault,
      pickExe: typeof hk.pickExe === 'string' ? hk.pickExe : d.hotkeys.pickExe,
    },
    globalHotkeys: s.globalHotkeys !== false,
    sshAgent: (() => {
      const a = (s.sshAgent && typeof s.sshAgent === 'object') ? s.sshAgent : {};
      return {
        enabled: a.enabled !== false,
        binDir: typeof a.binDir === 'string' ? a.binDir : '',
        keys: Array.isArray(a.keys) ? a.keys.filter((k) => typeof k === 'string' && k.trim()) : [],
      };
    })(),
    fontSize: Number.isFinite(fontSize) ? Math.min(32, Math.max(8, fontSize)) : d.fontSize,
    fontFamily: typeof s.fontFamily === 'string' && s.fontFamily ? s.fontFamily : d.fontFamily,
    scrollback: Number.isFinite(scrollback) ? Math.min(200000, Math.max(100, scrollback)) : d.scrollback,
    confirmCloseLive: s.confirmCloseLive !== false,
  };
}

class Settings {
  constructor(file) {
    this.file = file;
    this.data = defaultSettings();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      } else {
        this.data = defaultSettings();
        this.save(this.data); // materialize the file so it's editable by hand
      }
    } catch (err) {
      console.error('[terman] settings unreadable, using defaults:', err.message);
      this.data = defaultSettings();
    }
    return this.data;
  }

  save(patch) {
    this.data = normalize({ ...this.data, ...(patch || {}) });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[terman] could not write settings:', err.message);
    }
    return this.data;
  }

  profile(id) {
    return this.data.profiles.find((p) => p.id === id) || null;
  }

  defaultProfile() {
    return this.profile(this.data.defaultProfileId) || this.data.profiles[0] || null;
  }
}

module.exports = { Settings, defaultSettings, normalize, homeDir: () => os.homedir() };
