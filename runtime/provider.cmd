@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "LOG_DIR=%SCRIPT_DIR%logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "LOG_FILE=%LOG_DIR%\last-run.log"
set "NODE_STDERR_LOG=%LOG_DIR%\node-stderr.log"

> "%LOG_FILE%" echo Steam Import Node Provider runtime start
> "%NODE_STDERR_LOG%" echo.
>> "%LOG_FILE%" echo script_dir=%SCRIPT_DIR%
>> "%LOG_FILE%" echo working_dir=%CD%
>> "%LOG_FILE%" echo runtime_entry=%SCRIPT_DIR%provider.mjs
>> "%LOG_FILE%" echo bundled_node=%SCRIPT_DIR%node.exe
>> "%LOG_FILE%" echo bundled_node_dir=%SCRIPT_DIR%node\node.exe
>> "%LOG_FILE%" echo GAME_LIBRARY_NODE=%GAME_LIBRARY_NODE%
>> "%LOG_FILE%" echo PATH=%PATH%

set "NODE_EXE=%SCRIPT_DIR%node.exe"

if exist "%NODE_EXE%" (
  >> "%LOG_FILE%" echo node_source=bundled-file
  goto run
)
>> "%LOG_FILE%" echo bundled_node_missing=%NODE_EXE%

set "NODE_EXE=%SCRIPT_DIR%node\node.exe"

if exist "%NODE_EXE%" (
  >> "%LOG_FILE%" echo node_source=bundled-directory
  goto run
)
>> "%LOG_FILE%" echo bundled_node_dir_missing=%NODE_EXE%

set "NODE_EXE=%GAME_LIBRARY_NODE%"

if not "%NODE_EXE%"=="" (
  if exist "%NODE_EXE%" (
    >> "%LOG_FILE%" echo node_source=GAME_LIBRARY_NODE
    goto run
  )
  >> "%LOG_FILE%" echo GAME_LIBRARY_NODE_missing=%NODE_EXE%
  echo GAME_LIBRARY_NODE points to a missing node executable: %NODE_EXE% 1>&2
  echo Steam Import Node Provider runtime failed. See log: %LOG_FILE% 1>&2
  exit /b 1
)

>> "%LOG_FILE%" echo where_node_begin
where node >> "%LOG_FILE%" 2>&1
>> "%LOG_FILE%" echo where_node_end

for /f "delims=" %%I in ('where node 2^>nul') do (
  set "NODE_EXE=%%I"
  >> "%LOG_FILE%" echo node_source=PATH
  goto run
)

echo Node.js was not found for Steam Import Node Provider. Copy node.exe to runtime\node.exe, install Node.js 20+, or set GAME_LIBRARY_NODE to the full node.exe path. 1>&2
echo Steam Import Node Provider runtime failed. See log: %LOG_FILE% 1>&2
>> "%LOG_FILE%" echo error=node_not_found
exit /b 1

:run
>> "%LOG_FILE%" echo selected_node=%NODE_EXE%
if not exist "%SCRIPT_DIR%provider.mjs" (
  echo Steam Import Node Provider runtime entry was not found: %SCRIPT_DIR%provider.mjs 1>&2
  echo Steam Import Node Provider runtime failed. See log: %LOG_FILE% 1>&2
  >> "%LOG_FILE%" echo error=provider_mjs_missing
  exit /b 1
)

set "STEAM_IMPORT_PLUGIN_LOG=%LOG_FILE%"
>> "%LOG_FILE%" echo command="%NODE_EXE%" "%SCRIPT_DIR%provider.mjs"
"%NODE_EXE%" "%SCRIPT_DIR%provider.mjs" 2> "%NODE_STDERR_LOG%"
set "STATUS=%ERRORLEVEL%"
>> "%LOG_FILE%" echo node_exit_code=%STATUS%
>> "%LOG_FILE%" echo node_stderr_log=%NODE_STDERR_LOG%
if exist "%NODE_STDERR_LOG%" (
  >> "%LOG_FILE%" echo node_stderr_begin
  type "%NODE_STDERR_LOG%" >> "%LOG_FILE%"
  >> "%LOG_FILE%" echo node_stderr_end
)
if not "%STATUS%"=="0" (
  echo Steam Import Node Provider runtime failed with exit code %STATUS%. See log: %LOG_FILE% 1>&2
)
exit /b %STATUS%
