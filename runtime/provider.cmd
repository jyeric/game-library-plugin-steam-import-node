@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "NODE_EXE=%SCRIPT_DIR%node.exe"

if exist "%NODE_EXE%" goto run

set "NODE_EXE=%SCRIPT_DIR%node\node.exe"

if exist "%NODE_EXE%" goto run

set "NODE_EXE=%GAME_LIBRARY_NODE%"

if not "%NODE_EXE%"=="" (
  if exist "%NODE_EXE%" goto run
  echo GAME_LIBRARY_NODE points to a missing node executable: %NODE_EXE% 1>&2
  exit /b 1
)

for /f "delims=" %%I in ('where node 2^>nul') do (
  set "NODE_EXE=%%I"
  goto run
)

echo Node.js was not found for Steam Import Node Provider. Copy node.exe to runtime\node.exe, install Node.js 20+, or set GAME_LIBRARY_NODE to the full node.exe path. 1>&2
exit /b 1

:run
if not exist "%SCRIPT_DIR%provider.mjs" (
  echo Steam Import Node Provider runtime entry was not found: %SCRIPT_DIR%provider.mjs 1>&2
  exit /b 1
)

"%NODE_EXE%" "%SCRIPT_DIR%provider.mjs"
exit /b %ERRORLEVEL%
