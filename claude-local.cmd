@echo off
rem claude-local.cmd — Windows cmd wrapper; forwards to the PowerShell launcher.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-local.ps1" %*
