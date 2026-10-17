# Steam Import Node Provider

Version 0.3.1 uses the current client's `json-rpc/1` protocol. It imports installed Steam games, owned account games and family-shared games, and returns Steam launch URLs. The plugin has no npm dependencies and ships a visible `logo.svg`.

## Build and install

Run `npm test`, then `npm run package`. Install the resulting `game-library-plugin-steam-import-node.zip` from the client's Plugins page, review its code and approve its digest separately. Install the managed Node **22.22.0** runtime in client settings if missing; the host owns its pinned distribution and verification. Node is not bundled in the plugin ZIP.

A 0.2.x package uses retired `json-rpc-stdio-v2` declarations and cannot be installed in the current client. Rebuild from 0.3.0; changing only the manifest is insufficient because initialization, invocation and results all changed.

The manifest explicitly groups all three providers under the client's existing `steam` family. Version 0.3.1 requires the matching client update that supports `providers: [{id, name, familyId}]` in json-rpc/1 manifests. These entries are display metadata only; executable routing remains declared by `capabilities` and `actions`.

## Import and sign in

The Import page exposes the plugin's installed-game and account connectors after code approval and runtime installation. Select the plugin connector explicitly. Installed-game discovery accepts either the detected Windows Steam libraries or the selected library roots supplied by the client. Register/bind `import.library` when requested by the client; installation does not select an active importer automatically.

Use the account connector's sign-in action to open a dedicated Edge/Chrome Steam login window. The approved plugin starts its own login helper with the same managed Node executable. Steam cookies and refreshed access tokens remain under the current user's `~/.game-library-steam`, outside the approved code directory. Login must complete before account import. No Steam Web API key is required. Account candidates do not create launch options for uninstalled games; install those games through Steam first. Installed-game candidates supply explicit Steam URL launch options and their installation directory for tracking.

The plugin fetches Steam endpoints directly through Node, as permitted for trusted `json-rpc/1` code. The retired `http.fetchAllowed` and reviewed-command callbacks are not used. Client host HTTP proxy settings are not automatically applied to Node fetch. Browser login supports `GAME_LIBRARY_PROXY_SERVER`, `HTTPS_PROXY` or `HTTP_PROXY` when run manually; the current host intentionally clears inherited environment variables.

The browser has an isolated profile in the session directory and clears stale profile cookies on a new login. Access-cookie expiry uses the saved `steamRefresh_steam` cookie through Steam's WebBrowser refresh and cross-domain transfers. A rejected session returns a recoverable login-required error. Startup failures clear the pending state so the user can retry. Real Steam login requires Edge/Chrome on Windows.

## Protocol and capabilities

The host first sends `plugin.initialize` with protocolVersion 1 and the package ID, then `action.invoke` with action, invocationId, operationKey and input. Responses contain domain data directly. Old `executeAction` calls are rejected. No host callbacks are declared.

| Provider | Capability | Action |
| --- | --- | --- |
| `community.steam_import_node.import` | `import.library` | discover |
| same | `imports.detectLibraries` | detect-libraries |
| same | `imports.readCandidates` | read-candidates |
| `community.steam_import_node.account` | `accounts.readCandidates` | read-account-candidates |
| same | `accounts.status` | account-status |
| same | `accounts.login` | login |
| `community.steam_import_node.launch` | `launch.resolveProvider` | resolve-launch |
| same | `launch.requestProvider` | request-launch |

Provider IDs use dots because current manifest identities prohibit colons. Existing sources configured with old `:import`, `:account` or `:launch` IDs must be reselected. Historical package-local `.session` files remain untouched; sign in again to populate the persistent session directory.

`manifest.template.json` matches the install manifest. Absolute interpreter/root placeholders and `manifest.local.json` are unnecessary. The ZIP excludes tests, logs, local manifests and Node binaries.

## Verification

`npm test` uses fake Steam libraries, mock HTTP responses and a mocked browser subprocess; it does not scan the real library, authenticate a real account or launch a real game. Transport tests run real Node processes with the host's handshake and invocation envelopes. `tests/nativeEnvironment.test.mjs` checks browser/registry lookup without inherited application variables and session paths outside code.

For the client-native integration, use its opt-in `plugin-runtime` test `external_steam_package` with this built ZIP, `tests/fixtures/Steam` and the client's reviewed Node 22.22.0 archive. This validates package inspection, installation without implicit trust, explicit approval, real host invocation and revocation.
