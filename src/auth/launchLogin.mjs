import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionFilePath } from "../steam/session.mjs";
import { findBrowserExecutable } from "./browserExecutable.mjs";

/** Start the login helper with the same managed Node and persistent data root. */
export function launchSteamLogin(spawnProcess = spawn, browserPath = findBrowserExecutable()) {
  return new Promise((resolve, reject) => {
    if (!browserPath) throw new Error("Microsoft Edge or Chrome was not found. Install Edge/Chrome before signing in to Steam.");
    const helper = fileURLToPath(new URL("./steam-auth.mjs", import.meta.url));
    const child = spawnProcess(process.execPath, [helper, "auth", "--data-dir", dirname(sessionFilePath()), "--browser", browserPath], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
