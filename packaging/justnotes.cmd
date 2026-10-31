@echo off
rem The justnotes command of the installed Windows app: dist\cli\justnotes.mjs
rem run by the app's own binary as Node. It sits in resources\cli.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\justnotes.exe" "%~dp0justnotes.mjs" %*
