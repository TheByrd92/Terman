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

## Using it

| Action | How |
| --- | --- |
| New terminal (default profile) | <kbd>Ctrl</kbd>+<kbd>`</kbd> or the `+` button |
| Open a specific exe | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> or the `…` button |
| Settings | <kbd>Ctrl</kbd>+<kbd>,</kbd> or the gear |
| Close current tab | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd>, the tab's `×`, or middle-click the tab |
| Next / previous tab | <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> |
| Toggle DevTools | <kbd>F12</kbd> |

Tab labels follow the shell's own title (the `OSC 0` sequence), so an MSYS bash tab
reads as its current directory. The dot is green while the process lives and red once
it exits; the tab sticks around after exit so you can still read the scrollback.

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
