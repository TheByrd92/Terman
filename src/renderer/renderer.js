'use strict';

/* globals Terminal, FitAddon, WebLinksAddon */

const api = window.terman;

const el = {
  tabs: document.getElementById('tabs'),
  panes: document.getElementById('panes'),
  empty: document.getElementById('empty-state'),
  statusLeft: document.getElementById('status-left'),
  statusRight: document.getElementById('status-right'),
  toast: document.getElementById('toast'),
  kbdNew: document.getElementById('kbd-new'),
  kbdPick: document.getElementById('kbd-pick'),
  sshPill: document.getElementById('ssh-pill'),
};

/** @type {Array<{id:number,name:string,exe:string,cwd:string,title:string,alive:boolean,group:string|null,term:any,fit:any,pane:HTMLElement,tab:HTMLElement}>} */
let tabs = [];
let activeId = null;
let settings = null;
let toastTimer = null;

const XTERM_THEME = {
  background: '#12131a',
  foreground: '#d7dae4',
  cursor: '#6ea8fe',
  cursorAccent: '#12131a',
  selectionBackground: 'rgba(110,168,254,0.32)',
  black: '#12131a',
  red: '#ff6b6b',
  green: '#4ec9a5',
  yellow: '#ffd479',
  blue: '#6ea8fe',
  magenta: '#c792ea',
  cyan: '#66d9ef',
  white: '#d7dae4',
  brightBlack: '#5a6078',
  brightRed: '#ff8f8f',
  brightGreen: '#7bdcb5',
  brightYellow: '#ffe1a3',
  brightBlue: '#9ec5ff',
  brightMagenta: '#dcb2f5',
  brightCyan: '#9beefb',
  brightWhite: '#ffffff',
};

// ---------------------------------------------------------------- helpers

function toast(message, isError = true) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  el.toast.style.borderLeftColor = isError ? 'var(--danger)' : 'var(--ok)';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 5000);
}

// Surface renderer faults in the UI; a silent failure here looks like a dead button.
window.addEventListener('error', (e) => {
  console.error('[terman] uncaught', e.error || e.message);
  toast(`Error: ${e.message}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  console.error('[terman] unhandled rejection', r);
  toast(`Error: ${(r && r.message) || r}`);
});

function basename(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/** Split a command-line-ish string into argv, honouring double quotes. */
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/**
 * Shells announce their state via OSC 0/2. MSYS bash opens by reporting its own
 * exe path, which is noise next to the profile name, so ignore that case.
 *
 * Anything else is kept whole. Remote titles are the valuable ones -- tmux with
 * `set-titles on` reports e.g. "web-01: deploy (logs)" straight through ssh, and
 * clipping that at a fixed character count loses the session name. The tab has a
 * CSS max-width with text-overflow:ellipsis, so it truncates to the pixels
 * actually available and the full string stays in the tooltip. The cap here only
 * guards against a pathological multi-kilobyte title.
 */
function prettyTitle(raw, session) {
  let t = String(raw || '').trim();
  if (!t) return session.name;
  if (t.includes('\\')) t = basename(t);
  if (t.toLowerCase() === basename(session.exe).toLowerCase()) return session.name;
  return t.length > 200 ? `${t.slice(0, 199)}\u2026` : t;
}

/**
 * A leading "host: " on a tmux title (from set-titles-string "#h: #S (#W)") is the
 * least interesting part on a narrow tab -- you already know which box you opened,
 * and an IP eats the width the session name needs. Drop it from the label; the full
 * title including the host stays in the tab tooltip.
 *
 * Requires a hostname-shaped prefix of 2+ chars followed by a space, so a bare
 * Windows drive ("D: foo") or a colon-free path ("/d/Local_Code") is left alone.
 */
const HOST_PREFIX = /^([A-Za-z0-9_.-]{2,}):[ \t]+(?=\S)/;

function tabLabel(title, session) {
  const t = String(title || '').trim();
  if (!t) return session.name;
  const stripped = t.replace(HOST_PREFIX, '');
  return stripped || t;
}

/** "Control+Shift+`" -> "Ctrl+Shift+`" for display. */
function prettyAccel(accel) {
  return String(accel || '')
    .replace(/\bControl\b|\bCmdOrCtrl\b|\bCommandOrControl\b/g, 'Ctrl')
    .replace(/\bSuper\b|\bMeta\b/g, 'Win');
}

/** Parse an Electron accelerator so the same combo can be matched in-window. */
function parseAccel(accel) {
  const parts = String(accel || '').split('+').map((p) => p.trim()).filter(Boolean);
  const spec = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'control' || low === 'ctrl' || low === 'cmdorctrl' || low === 'commandorcontrol') spec.ctrl = true;
    else if (low === 'shift') spec.shift = true;
    else if (low === 'alt' || low === 'option') spec.alt = true;
    else if (low === 'super' || low === 'meta' || low === 'cmd' || low === 'command') spec.meta = true;
    else spec.key = low;
  }
  return spec.key ? spec : null;
}

function matchesAccel(event, spec) {
  if (!spec) return false;
  if (event.ctrlKey !== spec.ctrl || event.shiftKey !== spec.shift) return false;
  if (event.altKey !== spec.alt || event.metaKey !== spec.meta) return false;
  const key = String(event.key || '').toLowerCase();
  const code = String(event.code || '').toLowerCase();
  // Shift changes event.key ("`" -> "~"), so accept the physical key too.
  return key === spec.key
    || code === `key${spec.key}`
    || code === `digit${spec.key}`
    || (spec.key === '`' && code === 'backquote');
}

// ---------------------------------------------------------------- tab groups

/**
 * Browser-style tab groups: drag one tab onto another and the two share a colour.
 * Drag a tab onto empty strip space to leave its group.
 *
 * Deliberately just a colour -- no names, no collapsing, no persistence. The point
 * is to tell four ssh tabs apart at a glance, and a name would cost tab width the
 * tmux title needs.
 */
const GROUP_COLORS = ['#6ea8fe', '#4ec9a5', '#ffd479', '#c792ea', '#ff8f8f', '#66d9ef', '#f0a36b', '#8fd46a'];

/** @type {Map<string, string>} groupId -> css colour */
const groupColors = new Map();
let nextGroupId = 1;
let dragId = null;
let pendingRender = false;

/** A colour no live group is already using. */
function unusedColor() {
  const taken = new Set(groupColors.values());
  const free = GROUP_COLORS.filter((c) => !taken.has(c));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  // More groups than palette entries -- fall back to a random hue at the same
  // lightness so it still sits in the theme.
  return `hsl(${Math.floor(Math.random() * 360)} 62% 68%)`;
}

function newGroup() {
  const id = `g${nextGroupId++}`;
  groupColors.set(id, unusedColor());
  return id;
}

/** Dissolve any group down to fewer than two members, freeing its colour for reuse. */
function pruneGroups() {
  for (const id of [...groupColors.keys()]) {
    const members = tabs.filter((t) => t.group === id);
    if (members.length < 2) {
      for (const m of members) m.group = null;
      groupColors.delete(id);
    }
  }
}

/** Move a tab so it sits directly after another in the strip. */
function moveAfter(t, anchor) {
  tabs = tabs.filter((x) => x !== t);
  tabs.splice(tabs.indexOf(anchor) + 1, 0, t);
}

/**
 * Drop of `sourceId` onto `targetId`: join the target's group, or start a new one
 * from the pair. The source moves to the end of the group's run, because a group
 * whose members aren't adjacent reads as two groups sharing a colour.
 */
function groupTabs(sourceId, targetId) {
  const src = tabs.find((x) => x.id === sourceId);
  const dst = tabs.find((x) => x.id === targetId);
  if (!src || !dst || src === dst) return;

  const group = dst.group || newGroup();
  dst.group = group;
  src.group = group;

  const others = tabs.filter((t) => t.group === group && t !== src);
  moveAfter(src, others[others.length - 1]);

  pruneGroups();
  renderTabs();
}

function ungroup(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t || !t.group) return;
  t.group = null;
  pruneGroups();
  renderTabs();
}

function endDrag() {
  dragId = null;
  for (const n of el.tabs.querySelectorAll('.dragging, .drop-target')) {
    n.classList.remove('dragging', 'drop-target');
  }
  if (pendingRender) {
    pendingRender = false;
    renderTabs();
  }
}

/** Dropping on the strip itself -- past the last tab -- means "leave the group". */
el.tabs.addEventListener('dragover', (e) => { if (dragId !== null) e.preventDefault(); });
el.tabs.addEventListener('drop', (e) => {
  if (dragId === null || e.target !== el.tabs) return;
  e.preventDefault();
  const from = dragId;
  endDrag();
  ungroup(from);
});

// ---------------------------------------------------------------- rendering

function renderTabs() {
  // A shell can retitle itself mid-drag (tmux does it on every window switch), and
  // rebuilding the strip would destroy the element under the cursor. Defer to dragend.
  if (dragId !== null) {
    pendingRender = true;
    return;
  }

  el.tabs.replaceChildren(...tabs.map((t) => {
    const tab = document.createElement('div');
    tab.className = `tab${t.id === activeId ? ' active' : ''}${t.alive ? '' : ' dead'}${t.group ? ' grouped' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.draggable = true;
    if (t.group) tab.style.setProperty('--group', groupColors.get(t.group));
    // Full title first -- it carries the host prefix the label strips, plus anything
    // the label ellipsised away.
    tab.title = [
      t.title !== t.name ? t.title : null,
      t.exe,
      t.cwd,
      t.alive ? null : '(process exited)',
    ].filter(Boolean).join('\n');

    const dot = document.createElement('span');
    dot.className = 'tab-dot';

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = t.label;

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '\u00d7';
    close.title = 'Close terminal';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });

    tab.append(dot, label, close);
    tab.addEventListener('click', () => activate(t.id));
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t.id); });

    tab.addEventListener('dragstart', (e) => {
      dragId = t.id;
      e.dataTransfer.effectAllowed = 'move';
      // Some drop targets never fire without payload, even when it goes unread.
      e.dataTransfer.setData('text/plain', String(t.id));
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', endDrag);
    tab.addEventListener('dragover', (e) => {
      if (dragId === null || dragId === t.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tab.classList.add('drop-target');
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-target'));
    tab.addEventListener('drop', (e) => {
      if (dragId === null) return;
      e.preventDefault();
      e.stopPropagation();   // the strip's own handler means "ungroup"
      const from = dragId;
      endDrag();
      groupTabs(from, t.id);
    });

    t.tab = tab;
    return tab;
  }));

  el.empty.hidden = tabs.length > 0;
  renderStatus();
}

function renderStatus() {
  const t = tabs.find((x) => x.id === activeId);
  el.statusLeft.textContent = t ? `${t.exe}${t.cwd ? `  \u2014  ${t.cwd}` : ''}` : '';
  const hk = settings ? settings.hotkeys : null;
  const scope = settings && settings.globalHotkeys ? '' : ' (this window)';
  el.statusRight.textContent = [
    `${tabs.length} terminal${tabs.length === 1 ? '' : 's'}`,
    hk ? `${prettyAccel(hk.newDefault)} new${scope}` : '',
  ].filter(Boolean).join('   \u00b7   ');
}

function activate(id) {
  activeId = id;
  for (const t of tabs) t.pane.classList.toggle('active', t.id === id);
  renderTabs();
  const t = tabs.find((x) => x.id === id);
  if (t) {
    fitTab(t);
    t.term.focus();
  }
}

function fitTab(t) {
  if (!t || t.pane.offsetWidth === 0) return;
  try {
    t.fit.fit();
    if (t.alive) api.resizePty(t.id, t.term.cols, t.term.rows);
  } catch { /* pane not laid out yet */ }
}

// ---------------------------------------------------------------- terminals

async function newTerminal(spec = {}) {
  const pane = document.createElement('div');
  pane.className = 'pane';
  el.panes.appendChild(pane);

  const term = new Terminal({
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    scrollback: settings.scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    macOptionIsMeta: false,
    theme: XTERM_THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch { /* optional */ }
  term.open(pane);

  // Size the viewport before spawning so the shell's first prompt wraps correctly.
  pane.classList.add('active');
  for (const t of tabs) t.pane.classList.remove('active');
  try { fit.fit(); } catch { /* ignore */ }

  const res = await api.createPty({ ...spec, cols: term.cols, rows: term.rows });
  if (!res || !res.ok) {
    term.dispose();
    pane.remove();
    const back = tabs[tabs.length - 1];
    if (back) activate(back.id);
    else renderTabs();
    toast(res ? res.error : 'Could not start terminal');
    return null;
  }

  const session = {
    id: res.id,
    name: res.name,
    exe: res.exe,
    cwd: res.cwd,
    title: res.name,   // full title, as reported by the shell
    label: res.name,   // what the tab shows: title minus the "host: " prefix
    alive: true,
    group: null,       // set by dragging one tab onto another
    term,
    fit,
    pane,
    tab: null,
  };
  tabs.push(session);

  term.onData((data) => api.writePty(session.id, data));
  term.onResize(({ cols, rows }) => api.resizePty(session.id, cols, rows));
  term.onTitleChange((title) => {
    const next = prettyTitle(title, session);
    const nextLabel = tabLabel(next, session);
    if (next !== session.title || nextLabel !== session.label) {
      session.title = next;
      session.label = nextLabel;
      renderTabs();
    }
  });

  activate(session.id);
  return session;
}

async function closeTab(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;

  if (t.alive && settings.confirmCloseLive) {
    const ok = await api.confirm({
      title: 'Close terminal',
      message: `Close "${t.label}"?`,
      detail: `${t.exe} is still running. Closing the tab terminates it.`,
    });
    if (!ok) return;
  }

  api.killPty(id);
  t.term.dispose();
  t.pane.remove();
  tabs = tabs.filter((x) => x.id !== id);
  pruneGroups();

  if (activeId === id) {
    const next = tabs[tabs.length - 1];
    if (next) activate(next.id);
    else { activeId = null; renderTabs(); }
  } else {
    renderTabs();
  }
}

/** Returns true if the active tab actually changed, so callers know whether to
 *  swallow the keypress -- with one tab open the key must reach the shell. */
function cycleTab(delta) {
  if (tabs.length < 2) return false;
  const i = tabs.findIndex((t) => t.id === activeId);
  activate(tabs[(i + delta + tabs.length) % tabs.length].id);
  return true;
}

async function pickAndOpen() {
  const exe = await api.pickExe();
  if (exe) await newTerminal({ exe, args: [] });
}

// ---------------------------------------------------------------- open picker

/**
 * What Ctrl+Shift+` opens. It used to go straight to the file dialog, which had the
 * priorities backwards -- opening a configured profile is the common case and
 * browsing the filesystem is the fallback, so that's the last row.
 *
 * Keyboard-first, because the thing that opens it is a keyboard shortcut. Starts on
 * the default profile so Enter alone is the same as Ctrl+`.
 */
const pui = {
  overlay: document.getElementById('picker-overlay'),
  list: document.getElementById('picker-list'),
};

/** @type {Array<{label:string,sub:string,tag:string,run:() => any}>} */
let pickerRows = [];
let pickerIndex = 0;

function renderPicker() {
  pui.list.replaceChildren(...pickerRows.map((r, i) => {
    const row = document.createElement('div');
    row.className = `picker-row${i === pickerIndex ? ' sel' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === pickerIndex));

    const key = document.createElement('span');
    key.className = 'picker-key';
    key.textContent = i < 9 ? String(i + 1) : '';

    const name = document.createElement('span');
    name.className = 'picker-name';
    name.textContent = r.label;

    const sub = document.createElement('span');
    sub.className = 'picker-sub';
    sub.textContent = r.tag ? `${r.sub}  ·  ${r.tag}` : r.sub;

    row.append(key, name, sub);
    row.addEventListener('click', () => choosePicker(i));
    // Hover moves the selection, so the mouse and the keyboard agree on what Enter does.
    row.addEventListener('mousemove', () => {
      if (pickerIndex !== i) {
        pickerIndex = i;
        renderPicker();
      }
    });
    return row;
  }));
}

function openPicker() {
  if (!settings) return;
  // Pressing the hotkey again dismisses it rather than stacking.
  if (!pui.overlay.hidden) {
    closePicker();
    return;
  }

  pickerRows = settings.profiles.map((p) => ({
    label: p.name,
    sub: basename(p.exe),
    tag: p.id === settings.defaultProfileId ? 'default' : '',
    run: () => newTerminal({ profileId: p.id }),
  }));
  pickerRows.push({
    label: 'Browse for an executable…',
    sub: settings.pickerRoot,
    tag: '',
    run: () => pickAndOpen(),
  });

  pickerIndex = Math.max(0, pickerRows.findIndex((r) => r.tag === 'default'));
  renderPicker();
  pui.overlay.hidden = false;
}

function closePicker() {
  pui.overlay.hidden = true;
  const t = tabs.find((x) => x.id === activeId);
  if (t) t.term.focus();
}

function movePicker(delta) {
  pickerIndex = (pickerIndex + delta + pickerRows.length) % pickerRows.length;
  renderPicker();
}

function choosePicker(i = pickerIndex) {
  const row = pickerRows[i];
  closePicker();
  if (row) row.run();
}

// ---------------------------------------------------------------- ssh agent

/**
 * Badge in the status bar: locked (no keys yet) or unlocked (n keys held).
 * Clicking runs ssh-add in a real tab, so the passphrase prompt is a tty prompt
 * and the secret never travels through Terman.
 */
async function refreshSshPill() {
  let s;
  try {
    s = await api.sshStatus();
  } catch {
    el.sshPill.hidden = true;
    return;
  }

  if (!s || !s.enabled) {
    el.sshPill.hidden = true;
    return;
  }

  el.sshPill.hidden = false;
  el.sshPill.classList.remove('locked', 'unlocked', 'off');

  if (!s.running) {
    el.sshPill.classList.add('off');
    el.sshPill.textContent = 'SSH agent off';
    el.sshPill.title = s.error ? `ssh-agent unavailable: ${s.error}` : 'ssh-agent not running';
    return;
  }

  if (s.keyCount > 0) {
    el.sshPill.classList.add('unlocked');
    el.sshPill.textContent = `SSH ${s.keyCount} key${s.keyCount === 1 ? '' : 's'}`;
    el.sshPill.title = 'Agent holds your key. New terminals connect without prompting.\nClick to add another key.';
  } else {
    el.sshPill.classList.add('locked');
    el.sshPill.textContent = 'SSH locked';
    el.sshPill.title = 'Agent is running but holds no key.\nClick to unlock - the passphrase prompt opens in a new tab.';
  }
}

async function unlockSsh() {
  const spec = await api.sshUnlockSpec();
  if (!spec) {
    toast('ssh-agent is not available.');
    return;
  }
  const session = await newTerminal({ exe: spec.exe, args: spec.args });
  if (!session) return;
  // ssh-add exits once the passphrase is accepted; re-check when it does.
  const done = api.onPtyExit((id) => {
    if (id === session.id) {
      done();
      setTimeout(refreshSshPill, 150);
    }
  });
}

// ---------------------------------------------------------------- settings ui

const sui = {
  overlay: document.getElementById('settings-overlay'),
  defaultProfile: document.getElementById('set-default-profile'),
  hkNew: document.getElementById('set-hk-new'),
  hkPick: document.getElementById('set-hk-pick'),
  global: document.getElementById('set-global'),
  pickerRoot: document.getElementById('set-picker-root'),
  defaultCwd: document.getElementById('set-default-cwd'),
  fontSize: document.getElementById('set-font-size'),
  fontFamily: document.getElementById('set-font-family'),
  scrollback: document.getElementById('set-scrollback'),
  confirmClose: document.getElementById('set-confirm-close'),
  sshEnabled: document.getElementById('set-ssh-enabled'),
  profileList: document.getElementById('profile-list'),
  warn: document.getElementById('hk-warn'),
};

/** Working copy so Cancel is a true cancel. */
let draftProfiles = [];

/** Executable basenames that can be tmux-backed. Asked for once; the rule lives in tmux.js. */
let tmuxShells = [];

/** PowerShell and cmd have no tmux to reach, so the toggle is meaningless for them. */
function canTmux(exe) {
  return tmuxShells.includes(basename(String(exe || '')).toLowerCase());
}

function renderProfileEditor() {
  const rows = draftProfiles.map((p, i) => {
    const row = document.createElement('div');
    row.className = 'profile';

    const name = document.createElement('input');
    name.type = 'text';
    name.value = p.name;
    name.placeholder = 'Name';
    name.addEventListener('input', () => { draftProfiles[i].name = name.value; });

    const exe = document.createElement('input');
    exe.type = 'text';
    exe.value = p.exe;
    exe.placeholder = 'C:\\path\\to\\shell.exe';
    exe.addEventListener('input', () => { draftProfiles[i].exe = exe.value; });

    const args = document.createElement('input');
    args.type = 'text';
    args.value = (p.args || []).join(' ');
    args.placeholder = 'args';
    args.addEventListener('input', () => { draftProfiles[i].args = splitArgs(args.value); });

    // tmux-backed: the tab holds a client and the work lives in the tmux server, so it
    // survives Terman restarting or crashing.
    const tmuxWrap = document.createElement('label');
    tmuxWrap.className = 'p-tmux';
    const tmuxBox = document.createElement('input');
    tmuxBox.type = 'checkbox';
    if (!draftProfiles[i].tmux) draftProfiles[i].tmux = { enabled: false, session: '' };
    tmuxBox.checked = !!draftProfiles[i].tmux.enabled;
    tmuxBox.addEventListener('change', () => { draftProfiles[i].tmux.enabled = tmuxBox.checked; });
    tmuxWrap.append(tmuxBox, document.createTextNode('tmux'));

    // Re-check on every keystroke rather than re-rendering the row, which would take the
    // focus out of the field being typed into.
    const syncTmuxEnabled = () => {
      const ok = canTmux(draftProfiles[i].exe);
      tmuxBox.disabled = !ok;
      tmuxWrap.classList.toggle('disabled', !ok);
      tmuxWrap.title = ok
        ? 'Run this profile inside tmux, so its terminals survive Terman restarting or crashing.'
        : 'Only bash, sh, zsh and wsl.exe can be tmux-backed — there is no tmux for this shell to reach.';
    };
    syncTmuxEnabled();
    exe.addEventListener('input', syncTmuxEnabled);

    const del = document.createElement('button');
    del.className = 'mini-btn p-del';
    del.textContent = '\u00d7';
    del.title = 'Remove profile';
    del.addEventListener('click', () => {
      draftProfiles.splice(i, 1);
      renderProfileEditor();
      renderDefaultProfileSelect();
    });

    row.append(name, exe, args, tmuxWrap, del);
    return row;
  });

  const hint = document.createElement('p');
  hint.className = 'profile-hint';
  hint.textContent = 'Name \u00b7 executable \u00b7 arguments \u00b7 tmux. Tick tmux to keep a profile\u2019s terminals alive across a Terman restart or crash. Edit settings.json directly to set a working directory, environment variables, or a tmux session name per profile.';

  sui.profileList.replaceChildren(hint, ...rows);
}

function renderDefaultProfileSelect() {
  const current = sui.defaultProfile.value || settings.defaultProfileId;
  sui.defaultProfile.replaceChildren(...draftProfiles.map((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name}  \u2014  ${basename(p.exe)}`;
    return opt;
  }));
  if (draftProfiles.some((p) => p.id === current)) sui.defaultProfile.value = current;
}

function showHotkeyWarning(status) {
  if (!status || !status.enabled) {
    sui.warn.hidden = true;
    return;
  }
  const bad = [];
  if (status.newDefault === 'taken') bad.push('the new-terminal hotkey');
  if (status.pickExe === 'taken') bad.push('the pick-executable hotkey');
  if (status.newDefault === 'invalid') bad.push('the new-terminal accelerator (unparseable)');
  if (status.pickExe === 'invalid') bad.push('the pick-executable accelerator (unparseable)');
  if (!bad.length) {
    sui.warn.hidden = true;
    return;
  }
  sui.warn.hidden = false;
  sui.warn.textContent = `Windows refused to register ${bad.join(' and ')} \u2014 another running app already owns the combo. Pick a different one, or uncheck system-wide to use it inside Terman only.`;
}

function openSettings() {
  draftProfiles = settings.profiles.map((p) => ({ ...p, args: [...(p.args || [])], env: { ...(p.env || {}) } }));
  renderProfileEditor();
  renderDefaultProfileSelect();
  sui.defaultProfile.value = settings.defaultProfileId;
  sui.hkNew.value = settings.hotkeys.newDefault;
  sui.hkPick.value = settings.hotkeys.pickExe;
  sui.global.checked = !!settings.globalHotkeys;
  sui.pickerRoot.value = settings.pickerRoot;
  sui.defaultCwd.value = settings.defaultCwd;
  sui.fontSize.value = settings.fontSize;
  sui.fontFamily.value = settings.fontFamily;
  sui.scrollback.value = settings.scrollback;
  sui.confirmClose.checked = !!settings.confirmCloseLive;
  sui.sshEnabled.checked = !!(settings.sshAgent && settings.sshAgent.enabled);
  api.hotkeyStatus().then(showHotkeyWarning);
  sui.overlay.hidden = false;
}

function closeSettings() {
  sui.overlay.hidden = true;
  const t = tabs.find((x) => x.id === activeId);
  if (t) t.term.focus();
}

async function saveSettings() {
  const profiles = draftProfiles
    .map((p, i) => ({ ...p, id: p.id || `profile-${Date.now()}-${i}`, name: p.name.trim() || basename(p.exe) }))
    .filter((p) => p.exe.trim());

  if (!profiles.length) {
    toast('Keep at least one profile with an executable path.');
    return;
  }

  settings = await api.saveSettings({
    profiles,
    defaultProfileId: sui.defaultProfile.value,
    hotkeys: { newDefault: sui.hkNew.value.trim(), pickExe: sui.hkPick.value.trim() },
    globalHotkeys: sui.global.checked,
    pickerRoot: sui.pickerRoot.value.trim(),
    defaultCwd: sui.defaultCwd.value.trim(),
    fontSize: Number(sui.fontSize.value),
    fontFamily: sui.fontFamily.value.trim(),
    scrollback: Number(sui.scrollback.value),
    confirmCloseLive: sui.confirmClose.checked,
    sshAgent: { ...(settings.sshAgent || {}), enabled: sui.sshEnabled.checked },
  });

  applyAppearance();
  applyHotkeyHints();
  refreshSshPill();
  closeSettings();
  toast('Settings saved.', false);
}

function applyAppearance() {
  for (const t of tabs) {
    t.term.options.fontSize = settings.fontSize;
    t.term.options.fontFamily = settings.fontFamily;
    t.term.options.scrollback = settings.scrollback;
  }
  const t = tabs.find((x) => x.id === activeId);
  if (t) fitTab(t);
  renderStatus();
}

function applyHotkeyHints() {
  el.kbdNew.textContent = prettyAccel(settings.hotkeys.newDefault);
  el.kbdPick.textContent = prettyAccel(settings.hotkeys.pickExe);
  renderStatus();
}

// ---------------------------------------------------------------- wiring

document.getElementById('btn-new').addEventListener('click', () => newTerminal());
document.getElementById('empty-new').addEventListener('click', () => newTerminal());
document.getElementById('btn-pick').addEventListener('click', openPicker);
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-cancel').addEventListener('click', closeSettings);
document.getElementById('settings-save').addEventListener('click', saveSettings);
document.getElementById('btn-reveal').addEventListener('click', () => api.revealSettings());
el.sshPill.addEventListener('click', unlockSsh);

document.getElementById('btn-browse-root').addEventListener('click', async () => {
  const dir = await api.pickFolder(sui.pickerRoot.value);
  if (dir) sui.pickerRoot.value = dir;
});

document.getElementById('btn-browse-cwd').addEventListener('click', async () => {
  const dir = await api.pickFolder(sui.defaultCwd.value);
  if (dir) sui.defaultCwd.value = dir;
});

document.getElementById('btn-add-profile').addEventListener('click', async () => {
  const exe = await api.pickExe();
  if (!exe) return;
  draftProfiles.push({
    id: `profile-${Date.now()}`,
    name: basename(exe).replace(/\.exe$/i, ''),
    exe,
    args: [],
    cwd: '',
    env: {},
    tmux: { enabled: false, session: '' },
  });
  renderProfileEditor();
  renderDefaultProfileSelect();
});

sui.overlay.addEventListener('click', (e) => { if (e.target === sui.overlay) closeSettings(); });
pui.overlay.addEventListener('click', (e) => { if (e.target === pui.overlay) closePicker(); });

api.onPtyData((id, data) => {
  const t = tabs.find((x) => x.id === id);
  if (t) t.term.write(data);
});

api.onPtyExit((id, code) => {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  t.alive = false;
  t.term.write(`\r\n\x1b[38;5;244m[process exited with code ${code}]\x1b[0m\r\n`);
  renderTabs();
});

// A hotkey can summon a brand-new window and fire before its settings have loaded,
// so both wait on init rather than reading a null `settings`.
api.onNewDefault(async () => { await ready; newTerminal(); });
api.onPickExe(async () => { await ready; openPicker(); });

// Another window saved settings; one file, so this window follows.
api.onSettingsChanged((data) => {
  settings = data;
  applyAppearance();
  applyHotkeyHints();
  refreshSshPill();
});

api.onHotkeyStatus((status) => {
  if (!sui.overlay.hidden) showHotkeyWarning(status);
  if (status && status.enabled && (status.newDefault === 'taken' || status.pickExe === 'taken')) {
    toast('A hotkey is already owned by another app \u2014 see Settings.');
  }
});

/**
 * Tab switching lives on Ctrl+Shift+Arrow rather than a two-key chord.
 *
 * Two reasons it has to be a real modifier: the whole combo can be swallowed here,
 * so nothing leaks through to the shell (a bare PageUp can't be -- there's no way to
 * know a chord is coming, so it would page vim/less/tmux on the way past). And
 * Ctrl+Shift+* is the space terminal emulators conventionally claim for themselves,
 * so it doesn't collide with readline or TUI bindings the way Alt+Arrow does.
 *
 * Kept window-local on purpose. It could be a global accelerator now that it has
 * modifiers, but tab switching is only meaningful when Terman is focused, and
 * registering it system-wide would steal the combo from every other app.
 */
const TAB_STEP = { ArrowRight: 1, ArrowLeft: -1 };

// Same combos, handled in-window. These only ever fire when the global
// registration is off or failed; otherwise the OS consumes the keypress first.
document.addEventListener('keydown', (e) => {
  if (!settings) return;

  if (!sui.overlay.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
    return;
  }

  // Every key, not just the handled ones: the terminal behind the overlay still holds
  // focus, so anything let through would be typed into the shell.
  if (!pui.overlay.hidden) {
    e.preventDefault();
    e.stopPropagation();
    // The combo that opened it also dismisses it, so both hotkey paths (system-wide
    // and in-window) behave the same.
    if (matchesAccel(e, parseAccel(settings.hotkeys.pickExe))) closePicker();
    else if (e.key === 'Escape') closePicker();
    else if (e.key === 'ArrowDown' || e.key === 'Tab') movePicker(1);
    else if (e.key === 'ArrowUp') movePicker(-1);
    else if (e.key === 'Enter') choosePicker();
    else if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < pickerRows.length) choosePicker(i);
    }
    return;
  }

  // Swallow only if a tab switch actually happened; with a single tab open the
  // keypress still belongs to the shell.
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && TAB_STEP[e.key] !== undefined) {
    if (cycleTab(TAB_STEP[e.key])) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }

  if (matchesAccel(e, parseAccel(settings.hotkeys.newDefault))) {
    e.preventDefault();
    e.stopPropagation();
    newTerminal();
    return;
  }
  if (matchesAccel(e, parseAccel(settings.hotkeys.pickExe))) {
    e.preventDefault();
    e.stopPropagation();
    openPicker();
    return;
  }
  // Conveniences that don't collide with common shell bindings.
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === ',') {
    e.preventDefault();
    e.stopPropagation();
    openSettings();
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
    e.preventDefault();
    e.stopPropagation();
    if (activeId != null) closeTab(activeId);
    return;
  }
  // Ctrl+Shift+N, not Ctrl+N: bare Ctrl+N is readline's next-history and vim's
  // completion, so it has to reach the shell.
  if (e.ctrlKey && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
    e.preventDefault();
    e.stopPropagation();
    api.newWindow();
    return;
  }
  if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    cycleTab(e.shiftKey ? -1 : 1);
  }
}, true);

new ResizeObserver(() => {
  const t = tabs.find((x) => x.id === activeId);
  if (t) fitTab(t);
}).observe(el.panes);

window.addEventListener('resize', () => {
  const t = tabs.find((x) => x.id === activeId);
  if (t) fitTab(t);
});

let booted = false;

/** Resolves once settings are loaded, so IPC that arrives during boot can wait. */
const ready = (async function init() {
  if (booted) return;
  booted = true;
  settings = await api.getSettings();
  // Fixed for the life of the process, so fetch it once rather than per settings open.
  try { tmuxShells = await api.tmuxShells(); } catch { tmuxShells = []; }
  applyHotkeyHints();
  refreshSshPill();
  renderTabs();
  // Only open the startup terminal if nothing raced ahead of us (e.g. a hotkey
  // fired while settings were still loading).
  if (tabs.length === 0) await newTerminal();
}());
