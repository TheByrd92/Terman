# Terman

A small terminal manager for Windows. One window, tabbed terminals, two global hotkeys.

- <kbd>Ctrl</kbd>+<kbd>`</kbd> — open a new terminal using the default profile
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> — browse `D:\Utilities\msys64` (configurable) and open whatever exe you pick

Both work system-wide by default, so they summon a terminal even when Terman isn't
focused. Everything is configurable in Settings.

## Installing

Build the artifacts, then run the installer:

```
npm install
npm run dist
```

That writes two things to `dist\`:

| Artifact | What it is |
| --- | --- |
| `Terman-1.0.0-Setup.exe` | Installer. Asks where to put it, makes Start Menu + desktop shortcuts, registers an entry in Add/Remove Programs. |
| `Terman-1.0.0-Portable.exe` | Single self-contained exe. No install, no registry, no shortcuts — runs from a USB stick or any folder. |

The installer is deliberately not one-click: it shows a directory page so you choose the
install folder, and it installs per-user (no admin prompt) by default. Uninstalling leaves
`%APPDATA%\terman\settings.json` alone, so reinstalling keeps your profiles.

`npm run dist:installer` and `npm run dist:portable` build just one target;
`npm run pack` produces an unpacked folder in `dist\win-unpacked\` without any installer.

The app icon is generated, not checked in as binary art — `npm run icon` regenerates
`build\icon.ico` from `build\make-icon.ps1`.

## Running from source

```
npm start
```

Or double-click **`Terman.vbs`** (no console window) / **`Terman.cmd`** (console attached,
useful for seeing main-process logs).

`npm run dev` opens DevTools and echoes spawn/hotkey diagnostics to stdout.

In VS Code, <kbd>F5</kbd> runs it with main-process breakpoints live and main's `console.log`
going to the Debug Console. Two more configs in `.vscode/launch.json`: *Terman: attach to
renderer* for breakpoints in `src/renderer/*` (start **Terman** first, then attach), and a
*main + renderer* compound that does both.

## Using it

| Action | How |
| --- | --- |
| New terminal (default profile) | <kbd>Ctrl</kbd>+<kbd>`</kbd> or the `+` button |
| Open a specific exe | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> or the `…` button |
| Settings | <kbd>Ctrl</kbd>+<kbd>,</kbd> or the gear |
| Close current tab | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd>, the tab's `×`, or middle-click the tab |
| Tab right / left | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>→</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>←</kbd> |
| Next / previous tab | <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> |
| Toggle DevTools | <kbd>F12</kbd> |

Tab switching is window-local rather than a system-wide hotkey — it's only meaningful when
Terman is focused, and claiming <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>→</kbd> globally would
take it from every other app. The combo is swallowed outright, so nothing reaches the
shell; `Ctrl+Shift+*` is the range terminal emulators conventionally reserve, which is why
it doesn't tread on readline or TUI keys the way <kbd>Alt</kbd>+arrow would.

Tab labels follow the shell's own title (the `OSC 0`/`OSC 2` sequence), so an MSYS bash
tab reads as its current directory. Long titles ellipsise to the available width; hover
the tab for the full title, exe and cwd. The dot is green while the process lives and red
once it exits; the tab sticks around after exit so you can still read the scrollback.

## tmux support

Terman names tabs after the tmux session you're attached to, including over ssh — so a
wall of identical `ssh` tabs becomes `web-01: deploy (logs)`, `db-02: migrate (psql)`.

### Setup

Add this to the **remote** machine's tmux config (the box tmux runs on, not the Windows
side):

```tmux
set -g set-titles on
set -g set-titles-string "#h: #S (#W)"
```

`#h` is the hostname, `#S` the session name, `#W` the current window. tmux writes that as
an OSC title sequence, it rides back through ssh as ordinary bytes, and Terman renames the
tab. Nothing to configure on the Terman side.

The tab itself shows only `deploy (logs)` — Terman strips the leading `host:` because an IP
eats the width the session name needs, and you already know which box you opened. Hover the
tab to get the host back, along with the exe and working directory. Keep `#h` in the format
string for that reason: it costs nothing on the tab and it's what the tooltip shows.

If you'd rather the tab were the bare session name with no window, drop `#W`:

```tmux
set -g set-titles-string "#h: #S"
```

To avoid editing remote config at all, put it in the profile's args instead:

```
ssh -t your-host "tmux set -g set-titles on \; new -A -s main"
```

### Finding the config file

Don't go hunting — ask tmux which files it reads:

```bash
tmux display-message -p '#{config_files}'
```

```
/etc/tmux.conf,/home/you/.tmux.conf,/home/you/.config/tmux/tmux.conf
```

That's the search list, not only the files that exist, so it also tells you where a new
one may go. To see which are actually present:

```bash
ls -la /etc/tmux.conf ~/.tmux.conf ~/.config/tmux/tmux.conf 2>/dev/null
```

Often none exist — tmux runs fine without a config, and most distros don't ship
`/etc/tmux.conf`. Just create `~/.tmux.conf`.

Failing that, search by name or by content:

```bash
find ~ -name '*tmux*' 2>/dev/null       # by name, under home
find / -name 'tmux.conf' 2>/dev/null    # whole system, slow
grep -rn 'set-titles' ~ 2>/dev/null     # by content
```

`2>/dev/null` drops permission-denied noise that would otherwise bury the results.

### Reloading after an edit

From inside tmux, with the prefix (default <kbd>Ctrl</kbd>+<kbd>b</kbd>) then `:`

```tmux
source-file ~/.tmux.conf
```

or from any shell:

```bash
tmux source-file ~/.tmux.conf
```

Worth binding so it's one keystroke — prefix + <kbd>r</kbd>:

```tmux
bind r source-file ~/.tmux.conf \; display-message "config reloaded"
```

If the tab doesn't pick up the new name after sourcing, detach and reattach:

```bash
tmux detach             # then reconnect with: tmux attach
```

and if it still doesn't, restart the server:

```bash
tmux kill-server        # kills every session and its processes
```

Keep in mind `source-file` is additive rather than a reset — it layers on top of the
options already set, so it won't revert anything you deleted from the file. When a setting
seems stuck at an old value, restart the server instead of sourcing repeatedly.

### When the tab actually renames

| When | Tab label |
| --- | --- |
| Attached, before you press anything | unchanged (still the shell's own title) |
| First keypress after attaching | becomes `session (window)` |
| `rename-session` | follows immediately |
| Switching tmux windows | follows immediately |

tmux only writes the title when the computed title *changes*, so there's a gap between
attaching and your first keystroke — in practice it names itself the moment you touch the
keyboard. Idle status-line redraws (`status-interval`) do not re-emit it.

Do **not** try to close that gap with a `client-attached` hook that toggles the option,
e.g. `set-hook -g client-attached 'set -g set-titles off ; set -g set-titles on'`. Tested:
it suppresses titles entirely rather than refreshing them. `refresh-client -S` in the same
hook does nothing either. Plain `set-titles on` is the working configuration.

## Settings

Stored at `%APPDATA%\terman\settings.json` — the **settings.json** button in the dialog
reveals it in Explorer. The file is written on first run with profiles auto-detected
from your machine.

```jsonc
{
  "profiles": [
    {
      "id": "msys-ucrt64",
      "name": "UCRT64",
      "exe": "D:\\Utilities\\msys64\\usr\\bin\\bash.exe",
      "args": ["-l"],
      "cwd": "",                                       // "" = your home directory
      "env": { "MSYSTEM": "UCRT64", "CHERE_INVOKING": "1" }
    }
  ],
  "defaultProfileId": "msys-ucrt64",
  "defaultCwd": "",                                    // folder new terminals open in
  "pickerRoot": "D:\\Utilities\\msys64",               // where Ctrl+Shift+` starts
  "hotkeys": { "newDefault": "Control+`", "pickExe": "Control+Shift+`" },
  "globalHotkeys": true,
  "fontSize": 14,
  "scrollback": 10000,
  "confirmCloseLive": true
}
```

The dialog covers the default profile, the default folder, both hotkeys, the picker
folder, appearance, and profile name/exe/args. Per-profile `cwd` and `env` are
JSON-file-only — that's where `MSYSTEM` lives, which is what makes UCRT64 / MINGW64 /
MSYS distinct rather than three copies of the same `bash.exe`.

### Where new terminals open

**Settings → Default terminal → Folder new terminals open in**, or `defaultCwd` in the
JSON. Most specific wins:

1. the folder a caller asked for explicitly,
2. that profile's own `cwd`, if it has one,
3. `defaultCwd`,
4. your home directory.

Each candidate has to actually be a directory, so a folder you later rename or delete
falls through to the next one instead of breaking the spawn. Leave `defaultCwd` blank
for home. Changes apply to terminals opened afterwards — existing tabs keep their cwd.

Hotkeys use [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)
syntax: `Control+``, `Alt+Shift+T`, `Super+1`. Saving re-registers them immediately.

### About system-wide hotkeys

`globalHotkeys: true` claims the combo from every other application. <kbd>Ctrl</kbd>+<kbd>`</kbd>
is also VS Code's terminal toggle, and Terman wins while it's running. Two ways out:

- pick a combo nothing else wants (`Alt+Shift+``), or
- uncheck **System-wide**, which narrows both hotkeys to "when Terman has focus".

If Windows refuses a registration because another app already owns it, Terman warns in
the Settings dialog rather than failing quietly.

## How it works

Electron shell, [xterm.js](https://xtermjs.org/) for rendering, and
[`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty) for real ConPTY
processes — so full-screen TUIs, colour, job control, and resize all behave.

`@lydell/node-pty` ships N-API prebuilt binaries as per-platform optional dependencies.
That matters here: it needs no MSVC toolchain and no `electron-rebuild` step, and the
same binary loads in both Node and Electron.

```
src/
  main.js               window, PTY lifecycle, global hotkeys, IPC
  preload.js            contextBridge surface (contextIsolation on, no nodeIntegration)
  settings.js           load/normalize/save + first-run profile detection
  renderer/             tab bar, xterm panes, settings dialog
build/
  make-icon.ps1         generates icon.ico
dist/                   build output (installer, portable exe) - not source
```

Packaging keeps `@lydell/node-pty` outside the asar archive (`asarUnpack`), because ConPTY
needs to launch a real `OpenConsole.exe` off disk and native `.node` files can't be loaded
from inside an archive.

The renderer never touches Node APIs; it drives PTYs entirely over IPC.

## Notes

- Closing the window kills every PTY it owns.
- Only one instance runs; launching again focuses the existing window.
- To build a standalone installer, add `electron-builder` — not wired up, since running
  from source is enough for a personal tool.
