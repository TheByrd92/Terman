@echo off
rem Launch Terman. Keeps a console attached, so main-process logs are visible.
rem For a clean, console-free launch use Terman.vbs instead.
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
