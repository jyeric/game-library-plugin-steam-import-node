# Steam Import Node Provider

This plugin is a JSON-RPC provider for Game Library Client. It scans installed Steam libraries and returns import candidates with `externalIds.steam`, then launches Steam games through `steam://rungameid/{appid}` URLs.

The plugin is intentionally small and dependency-free. It is a working example of moving a built-in platform workflow into a provider-first plugin.

## Features

- Detect a Steam root from `STEAM_ROOT`, then Windows registry, then `%ProgramFiles(x86)%` / `%ProgramFiles%`.
- Parse `steamapps/libraryfolders.vdf`.
- Parse `steamapps/appmanifest_*.acf`.
- Return installed Steam games through `imports.acceptCandidates`.
- Resolve and request launch through `launch.acceptRequest` with a Steam URL.
- Avoid hardcoded drive scanning. macOS and Linux auto-detection currently report unsupported unless `STEAM_ROOT` is provided.

## Layout

```text
runtime/
  provider.ps1        Windows JSON-RPC runtime wrapper used by the manifest.
  provider.cmd        Fallback wrapper for manual debugging.
  provider.mjs        stdin/stdout entrypoint.
src/
  jsonrpc/            JSON-RPC action routing.
  steam/              Steam VDF parsing, root detection, and scan logic.
tests/
  fixtures/           Fake Steam library data.
  steamImport.test.mjs
```

## Test

```powershell
npm test
```

The tests use fixtures under `tests/fixtures/Steam` and do not scan your real Steam library.

## Runtime Log

Every runtime execution overwrites:

```text
runtime/logs/last-run.log
```

If Game Library Client reports a JSON-RPC runtime failure, open this log first. It records the wrapper working directory, selected Node executable, missing path checks, Node exit code, runtime action id, host API, and JavaScript stack traces. The log is ignored by git.

## Runtime Requirement

This plugin runs on Node.js 20 or newer. When Game Library Client is launched from Explorer, it may not inherit the same `PATH` that your terminal sees.

The most reliable local setup is to copy your current `node.exe` next to the runtime wrapper. The copied executable is ignored by git:

```powershell
Copy-Item (Get-Command node).Source .\runtime\node.exe
```

Alternatively, set `GAME_LIBRARY_NODE` to the full `node.exe` path and restart the app:

```powershell
[Environment]::SetEnvironmentVariable("GAME_LIBRARY_NODE", "C:\path\to\node.exe", "User")
```

You can find your current Node path from a terminal with:

```powershell
(Get-Command node).Source
```

## Create a Local Manifest

The manifest template uses `<PLUGIN_ROOT>` because Game Library Client requires plugin runtime paths to stay inside an allowed root.

From this plugin directory:

```powershell
node -e "const fs=require('fs'); const root=process.cwd().replace(/\\/g,'\\\\'); fs.writeFileSync('manifest.local.json', fs.readFileSync('manifest.template.json','utf8').replaceAll('<PLUGIN_ROOT>', root));"
```

Do not commit `manifest.local.json`; it contains your local absolute path and is ignored by git.

## Import Into Game Library Client

1. Run `npm test` in this plugin folder.
2. Generate `manifest.local.json` with the command above.
3. Open Game Library Client.
4. Go to Settings and open the provider/plugin diagnostics area.
5. Paste or load the JSON from `manifest.local.json`.
6. Enable the plugin package.
7. Grant the requested permissions:
   - `games-read`
   - `launch-url`
8. Save the plugin package.
9. Open the Imports page and choose the Steam Import plugin provider.
10. Run the import scan. Imported candidates should include `externalIds.steam`.

For runtime testing against a non-standard Steam installation, set `STEAM_ROOT` before launching the app so the plugin process inherits it:

```powershell
$env:STEAM_ROOT = "D:\Steam"
```

Restart the app after changing environment variables.

## JSON-RPC Actions

The manifest declares four runtime actions:

- `detect-libraries` -> `imports.acceptLibraries`
- `read-candidates` -> `imports.acceptCandidates`
- `resolve-launch` -> `launch.acceptResolution`
- `request-launch` -> `launch.acceptRequest`

The runtime must read one JSON-RPC request from stdin and write one JSON-RPC response to stdout.

## Current Boundaries

- Windows auto-detection is implemented first.
- macOS/Linux support is limited to explicit `STEAM_ROOT` for now.
- Steam artwork, Steam metadata refresh, Steam Cloud save path discovery, and Steam account library import are future extensions.
- This plugin launches with `steam://rungameid/{appid}` and does not execute `steam.exe` directly.
