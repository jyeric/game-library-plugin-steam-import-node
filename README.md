# Steam Import Node Provider

This plugin is a JSON-RPC provider for Game Library Client. It scans installed Steam libraries, imports a logged-in Steam account library including family-shared games, and launches Steam games through `steam://rungameid/{appid}` URLs.

The plugin is intentionally small and npm dependency-free. It is a working example of moving a built-in platform workflow into a provider-first plugin.

## Features

- Detect a Steam root from `STEAM_ROOT`, then Windows registry, then `%ProgramFiles(x86)%` / `%ProgramFiles%`.
- Parse `steamapps/libraryfolders.vdf`.
- Parse `steamapps/appmanifest_*.acf`.
- Return installed Steam games through `imports.acceptCandidates`.
- Open a reviewed Steam browser login command and save Steam store cookies under the plugin data dir.
- Refresh the Steam store `webapi_token` from `https://store.steampowered.com/pointssummary/ajaxgetasyncconfig`.
- Return Steam account-library and family-shared games through `accounts.acceptCandidates` without requiring a Steam Web API key.
- Resolve and request launch through `launch.acceptRequest` with a Steam URL.
- Avoid hardcoded drive scanning. macOS and Linux auto-detection currently report unsupported unless `STEAM_ROOT` is provided.

## Layout

```text
runtime/
  provider.mjs        Direct Node stdin/stdout entrypoint.
src/
  auth/               Browser login helper that captures Steam cookies through Chrome/Edge CDP.
  jsonrpc/            JSON-RPC action routing.
  steam/              Steam VDF parsing, root detection, access-token refresh, and scan logic.
tests/
  fixtures/           Fake Steam library data.
  steamAccount.test.mjs
  steamImport.test.mjs
```

## Test

```powershell
npm test
```

The tests use fixtures under `tests/fixtures/Steam` and do not scan your real Steam library.

## Build Package

```powershell
npm run package
```

This writes `game-library-plugin-steam-import-node.zip` with only the runtime files needed by Game Library Client. It intentionally excludes `manifest.local.json`, tests, logs, and any local Node binary.

## Runtime Requirement

This plugin runs directly through Node.js 20 through 24. The manifest declares that supported range so the host can bind `<NODE_EXE>` for the reviewed Steam login helper. When no compatible Node runtime is detected, the install review can download the pinned portable Node.js 22.23.1 package after user approval; `node.exe` is not bundled in this ZIP.

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
2. Run `npm run package`.
3. Open Game Library Client.
4. Go to Settings and open the provider/plugin diagnostics area.
5. Install `game-library-plugin-steam-import-node.zip`.
6. Enable the plugin package.
7. Grant the requested permissions:
   - `games-read`
   - `launch-url`
   - `launch-process`
   - `http-allowed-domains`
8. Save the plugin package.
9. Open the Imports page and choose the Steam Import plugin provider.
10. Run the installed-game import scan. Imported candidates should include `externalIds.steam`.
11. For account and family-library import, choose the Steam Account and Family Library method. The Imports page shows the current Steam account or a login prompt. Confirm the reviewed browser command and complete login in the opened window before continuing.

The plugin stores Steam cookies in the plugin data directory and refreshes the short-lived store access token on demand. The built-in Steam Web API key setting is not used by this plugin.

For runtime testing against a non-standard Steam installation, set `STEAM_ROOT` before launching the app so the plugin process inherits it:

```powershell
$env:STEAM_ROOT = "D:\Steam"
```

Restart the app after changing environment variables.

## JSON-RPC Actions

The manifest declares seven runtime actions:

- `login` -> `accounts.acceptStatus`
- `account-status` -> `accounts.acceptStatus`
- `detect-libraries` -> `imports.acceptLibraries`
- `read-candidates` -> `imports.acceptCandidates`
- `read-account-candidates` -> `accounts.acceptCandidates`
- `resolve-launch` -> `launch.acceptResolution`
- `request-launch` -> `launch.acceptRequest`

The runtime must read one JSON-RPC request from stdin and write one JSON-RPC response to stdout.

## Current Boundaries

- Windows auto-detection is implemented first.
- macOS/Linux support is limited to explicit `STEAM_ROOT` for now.
- Steam artwork, Steam metadata refresh, and Steam Cloud save path discovery are future extensions.
- Steam account-family import depends on Steam's store access token and family library Web APIs, so the saved browser session must be refreshed when Steam expires it.
- This plugin launches with `steam://rungameid/{appid}` and does not execute `steam.exe` directly.
