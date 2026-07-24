' Double-click launcher: starts Terman with no console window flash.
' Point a Start Menu / taskbar shortcut at this file.
Dim shell, dir, exe
Set shell = CreateObject("WScript.Shell")

' Script directory, WITHOUT a trailing backslash -- a path ending in "\" directly
' before a closing quote would escape that quote and mangle the argument.
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
exe = dir & "\node_modules\electron\dist\electron.exe"

' Window style 1 (normal), NOT 0: style 0 sets SW_HIDE in the child's startup info and
' Chromium honours it, which creates the app window hidden. electron.exe is a GUI binary
' and never opens a console, so there is no console flash to suppress here -- launching
' via .vbs instead of .cmd is what avoids the cmd.exe window.
shell.Run """" & exe & """ """ & dir & """", 1, False
