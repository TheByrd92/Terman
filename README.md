# Terman

[![Build & release](https://github.com/TheByrd92/Terman/actions/workflows/build-portable.yml/badge.svg)](https://github.com/TheByrd92/Terman/actions/workflows/build-portable.yml)

A small terminal manager for Windows. Tabbed terminals, two global hotkeys.

- <kbd>Ctrl</kbd>+<kbd>`</kbd> — open a new terminal using the default profile
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> — pick from your profiles, or browse for any exe

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
| `Terman-<version>-Setup.exe` | Installer. Asks where to put it, makes Start Menu + desktop shortcuts, registers an entry in Add/Remove Programs. |
| `Terman-<version>-Portable.exe` | Single self-contained exe. No install, no registry, no shortcuts — runs from a USB stick or any folder. |

The version in both filenames is whatever `package.json` says.

The installer is deliberately not one-click: it shows a directory page so you choose the
install folder, and it installs per-user (no admin prompt) by default. Uninstalling leaves
`%APPDATA%\terman\settings.json` alone, so reinstalling keeps your profiles.

`npm run dist:installer` and `npm run dist:portable` build just one target;
`npm run pack` produces an unpacked folder in `dist\win-unpacked\` without any installer.

### Downloading a build from CI

`.github/workflows/build-portable.yml` builds the portable exe on every push to `main`
(and on pull requests) using a `windows-latest` runner — a Windows host is required, since
this packages a Windows Electron app plus a `win32-x64` native PTY.

**Per-push builds** land as a workflow artifact. Open the run under the repo's *Actions*
tab and download `Terman-<version>-Portable` from the summary page. GitHub zips artifacts
automatically, so you get a `.zip` with the exe inside. Kept 90 days. Downloading an
artifact requires being signed in to GitHub.

### Versioning

Versions bump themselves. Every push to `main` builds, bumps the **patch** number, commits
the new `package.json`/`package-lock.json` as `chore(release): vX.Y.Z [skip ci]`, tags it,
and publishes a GitHub Release with the exe attached — the only kind of download link that
works without a GitHub account.

Override the level from the commit message, or from **Actions → Build & release → Run
workflow** where it's a dropdown:

| In the commit message | Result |
| --- | --- |
| *(nothing)* | patch — `1.0.1` → `1.0.2` |
| `[minor]` | `1.0.1` → `1.1.0` |
| `[major]` or `[breaking]` | `1.0.1` → `2.0.0` |
| `[skip bump]` or `[no-bump]` | builds, no bump, no tag, no release |

Order of operations matters here: the bump is applied to `package.json` **before** the
build, so the exe filename matches the version, but it isn't committed or tagged until the
build has passed. A broken commit never gets a version tag.

Pull requests build and upload an artifact, and never bump — there's nowhere to push the
commit. Pushing a `v*` tag by hand still works too: that skips the bump and releases the
version already in `package.json`.

Two things to know if it ever misbehaves. The bump is pushed with the built-in
`GITHUB_TOKEN`, and pushes made with that token don't trigger workflows — that's what stops
the release commit from starting another run, and also why the release is published in the
same run rather than by the tag push. And the push is a plain fast-forward: if you push to
`main` while a build is running, the tag step fails loudly rather than rebasing a release
commit behind your back. Re-run it and it'll bump from wherever `main` now is.

The workflow caches the Electron download (~270 MB) keyed on `package-lock.json`, builds
with `CSC_IDENTITY_AUTO_DISCOVERY=false` since there's no signing certificate in CI, and
fails loudly if the exe is missing or implausibly small rather than uploading nothing. To
ship the installer as well, add `dist/Terman-*-Setup.exe` to the upload paths and switch
the build step to `npm run dist`.

The app icon is generated, not checked in as binary art — `npm run icon` regenerates
`build\icon.ico` from `build\make-icon.ps1`.

## Running from source

```
npm start
```

`npm run dev` adds `--dev`, which opens DevTools and echoes spawn/hotkey diagnostics.
Redirect stdout to see them (`npm run dev > log.txt`) — Electron is a GUI-subsystem binary
on Windows and doesn't write to an inherited console window.

In VS Code, <kbd>F5</kbd> runs it with main-process breakpoints live and main's `console.log`
going to the Debug Console. Two more configs in `.vscode/launch.json`: *Terman: attach to
renderer* for breakpoints in `src/renderer/*` (start **Terman** first, then attach), and a
*main + renderer* compound that does both.

## Using it

| Action | How |
| --- | --- |
| New terminal (default profile) | <kbd>Ctrl</kbd>+<kbd>`</kbd> or the `+` button |
| Pick a profile / any exe | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> or the `…` button |
| New window | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>, or just launch Terman again |
| Settings | <kbd>Ctrl</kbd>+<kbd>,</kbd> or the gear |
| Close current tab | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd>, the tab's `×`, or middle-click the tab |
| Group two tabs | drag one tab onto another |
| Leave a group | drag the tab onto empty space in the tab strip |
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

### The open picker

<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> lists your profiles, with the file browser as
the last row:

```
 1  UCRT64                      bash.exe
 2  MINGW64                     bash.exe
 3  MSYS                        bash.exe
 4  PowerShell 7                pwsh.exe
 5  Windows PowerShell          powershell.exe
 6  Command Prompt              cmd.exe
 7  AWS Fedora Box              ssh.exe  ·  default
 8  Browse for an executable…   D:\Utilities\msys64
```

| Key | Does |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> / <kbd>Tab</kbd> | move, wrapping at the ends |
| <kbd>1</kbd>…<kbd>9</kbd> | jump straight to that row |
| <kbd>Enter</kbd> | open the highlighted row |
| <kbd>Esc</kbd>, a click outside, or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> again | cancel |

It opens on the default profile, so <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> then
<kbd>Enter</kbd> is the same as <kbd>Ctrl</kbd>+<kbd>`</kbd>. Hovering with the mouse moves
the selection too, so hover-then-<kbd>Enter</kbd> does what it looks like.

Picking a profile is not the same as browsing to the same exe. Three of the rows above are
one `bash.exe` and differ only by the `MSYSTEM` variable that makes them UCRT64 / MINGW64 /
MSYS — the profile carries that `env` (and its `cwd`), while the file browser can only hand
over a path. Reach for the last row when you want something you haven't configured; if you
find yourself picking the same exe twice, it wants to be a profile.

Every keystroke is swallowed while the picker is open, including ones it doesn't use. The
terminal behind it still holds focus, and with an `ssh` profile as your default, a key that
leaked through would land on a remote box.

### Naming a tab yourself

The tab label is whatever the shell last reported via `OSC 0`/`OSC 2`, so write that
sequence and the tab renames immediately:

```bash
printf '\033]0;deploy\007'
```

That's `ESC ] 0 ;` *title* `BEL`. Use `printf`, not `echo` — `echo -e` isn't portable, and
`echo` without it prints the escape literally.

| Shell | Command |
| --- | --- |
| bash / zsh / any POSIX shell | `printf '\033]0;deploy\007'` |
| PowerShell | `$Host.UI.RawUI.WindowTitle = 'deploy'` |
| cmd | `title deploy` |
| inside tmux | `tmux rename-session deploy` |

In MSYS bash the name won't stick, because its default `PS1` re-emits the title (your
current directory) at every prompt and overwrites yours. To hold a name for the rest of
the session, set it from the prompt instead:

```bash
PROMPT_COMMAND='printf "\033]0;deploy\007"'
```

Two Terman-side rules apply to whatever you set: a title containing a backslash is
shortened to its last segment (that's how the noisy `C:\...\bash.exe` opening title
becomes just the profile name), and a `host: ` prefix is stripped for the label — so
`api: build` shows as `build`, with the full string in the tooltip. Avoid a colon if you
want the whole thing on the tab.

### Grouping tabs

Drag one tab onto another and both get the same colour — a tinted body and an underline.
Drag a third onto either of them to add it. The dragged tab moves next to its group so the
run stays contiguous.

There's no group name, no collapsing, and nothing to configure: the colour is the whole
feature, which is enough to tell four identical `ssh` tabs apart without spending tab
width a tmux title needs. Colours come from an eight-entry palette, picked at random from
the ones no other group is using.

To pull a tab out, drag it onto empty space in the strip past the last tab. A group that
drops below two members dissolves and hands its colour back. Groups live in the window
only — they aren't written to settings.json and don't survive a restart, same as the tabs
themselves.

## SSH: unlock your key once

A passphrase-protected key normally prompts **once per terminal**, because every tab is its
own process. Terman fixes that by running a single `ssh-agent` and handing its
`SSH_AUTH_SOCK` to every PTY it spawns — that variable is just the address of the agent's
socket, and any `ssh` that can see it asks the agent for the key instead of prompting. So
you unlock once per launch and every tab after that connects silently.

Click the **SSH** badge in the status bar:

| Badge | Meaning |
| --- | --- |
| `SSH locked` (amber) | agent running, holds no key — click to unlock |
| `SSH 1 key` (green) | agent holds your key; new terminals won't prompt |
| `SSH agent off` (dim) | `ssh-agent` not found, or disabled in Settings |

Clicking opens a tab running `ssh-add`. You type the passphrase there, at a real tty
prompt — **Terman never sees it**. It isn't stored, isn't written to disk, and isn't passed
through any Terman code path. The decrypted key lives in the agent's memory and is dropped
when Terman quits.

Deliberately *not* implemented: reading a password out of Windows Credential Manager to
feed `ssh` automatically. That converts an interactive secret into a stored one that any
process running as you can read back. An agent-held key has no such exposure. (`sshpass`
is worse still — it leaks the password into process arguments.)

If you already run your own agent, Terman adopts it rather than starting a second one, and
leaves it alone on exit — it only kills an agent it started itself.

Turn it off in **Settings → SSH agent**. Config lives under `sshAgent` in settings.json:

```jsonc
"sshAgent": {
  "enabled": true,
  "binDir": "",     // "" = auto-detect ssh-agent/ssh-add
  "keys": []        // [] = ssh-add defaults (~/.ssh/id_*), or list key paths
}
```

### Auto-connecting on a new terminal

An SSH terminal is just a profile whose executable is `ssh`:

| Field | Value |
| --- | --- |
| Name | `fedora` |
| Executable | `D:\Utilities\msys64\usr\bin\ssh.exe` |
| Args | `-t fedora@3.19.61.51 "tmux new -A -s main"` |

Set it as the default profile and <kbd>Ctrl</kbd>+<kbd>`</kbd> connects straight in. `-t`
forces a tty, which is required whenever you pass a remote command — without it tmux exits
with "not a terminal". The args field splits on spaces but honours double quotes, so the
remote command stays a single argument.

Use the msys `ssh.exe` specifically: it's the one that knows your `~/.ssh` config, and its
`HOME` resolves to the msys home even when Terman spawns it directly rather than through a
login shell.

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
  "pickerRoot": "D:\\Utilities\\msys64",               // where the Browse row starts
  "hotkeys": { "newDefault": "Control+`", "pickExe": "Control+Shift+`" },
  "globalHotkeys": true,
  "fontSize": 14,
  "scrollback": 10000,
  "confirmCloseLive": true
}
```

The dialog covers the default profile, the default folder, both hotkeys, the browse
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
  main.js               windows, PTY lifecycle, global hotkeys, IPC
  preload.js            contextBridge surface (contextIsolation on, no nodeIntegration)
  settings.js           load/normalize/save + first-run profile detection
  ssh-agent.js          agent lifecycle, SSH_AUTH_SOCK, key-count status
  renderer/             tab bar, tab groups, xterm panes, open picker, settings dialog
build/
  make-icon.ps1         generates icon.ico
dist/                   build output (installer, portable exe) - not source
```

Packaging keeps `@lydell/node-pty` outside the asar archive (`asarUnpack`), because ConPTY
needs to launch a real `OpenConsole.exe` off disk and native `.node` files can't be loaded
from inside an archive.

The renderer never touches Node APIs; it drives PTYs entirely over IPC.

## Windows

<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> opens another window, and so does launching
Terman again — the second launch hands off to the process already running and asks it for
a window instead of starting over. Each window has its own tabs, groups and terminals, and
closing one kills only the terminals it owns.

It's one process behind all of them, deliberately:

| Shared | Why it matters |
| --- | --- |
| The ssh-agent | You unlock once, and every window's terminals see the key. One agent per window would mean one passphrase prompt per window. |
| The global hotkeys | Only one process can own <kbd>Ctrl</kbd>+<kbd>`</kbd> system-wide. Registered once here, and it acts on the focused window (or the last focused one, if Terman isn't in front). |
| settings.json | A single writer. Save in one window and the others pick up the font size and hotkey hints immediately rather than keeping what they launched with. |

<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> rather than <kbd>Ctrl</kbd>+<kbd>N</kbd>,
because bare <kbd>Ctrl</kbd>+<kbd>N</kbd> is readline's next-history and vim's completion —
it has to reach the shell.

The title bar carries the version (`Terman 1.0.1`), which is the quickest way to tell which
build a window is, and comes from `package.json` via `app.getVersion()`.

## Notes

- Closing a window kills every PTY it owns; quitting kills the ssh-agent with it.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Fork it, change it, ship it; derivative works
stay under the same license.

Dependencies are all permissive (MIT): Electron, xterm.js, `@lydell/node-pty`.
