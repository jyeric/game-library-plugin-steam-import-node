import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Locate the login browser even when the host supplies only SystemRoot. */
export function findBrowserExecutable({ env = process.env, home = homedir(), exists = existsSync, platform = process.platform } = {}) {
  if (platform !== "win32") return undefined;
  const drive = path.win32.parse(env.SystemRoot ?? "C:\\Windows").root;
  const roots = [env.ProgramFiles ?? path.win32.join(drive, "Program Files"),
    env["ProgramFiles(x86)"] ?? path.win32.join(drive, "Program Files (x86)"),
    env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")];
  return [env.MSEDGE, ...roots.flatMap(root => [
    path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
  ])].filter(Boolean).find(exists);
}
