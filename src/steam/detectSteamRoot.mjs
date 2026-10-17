import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync as defaultExecFileSync } from "node:child_process";

export function detectSteamRoot({
  env = process.env,
  platform = process.platform,
  execFileSync = defaultExecFileSync,
} = {}) {
  const explicitRoot = normalizeExistingPath(env.STEAM_ROOT);
  if (explicitRoot) {
    return { root: explicitRoot, source: "STEAM_ROOT" };
  }

  if (platform !== "win32") {
    return {
      root: null,
      source: "unsupported",
      reason: `Steam auto-detection currently supports Windows only; set STEAM_ROOT to test a custom Steam root on ${platform}.`,
    };
  }

  const registryRoot = detectWindowsSteamRootFromRegistry(execFileSync, env);
  if (registryRoot) {
    return { root: registryRoot, source: "windows-registry" };
  }

  const programFilesRoot = detectWindowsSteamRootFromProgramFiles(env);
  if (programFilesRoot) {
    return { root: programFilesRoot, source: "program-files" };
  }

  return {
    root: null,
    source: "not-found",
    reason: "Steam root was not found. Set STEAM_ROOT to the Steam installation directory and restart the app.",
  };
}

function detectWindowsSteamRootFromRegistry(execFileSync, env) {
  const keys = [
    ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
    ["HKLM\\Software\\Valve\\Steam", "InstallPath"],
    ["HKLM\\Software\\WOW6432Node\\Valve\\Steam", "InstallPath"],
  ];

  for (const [key, valueName] of keys) {
    try {
      const executable = env.SystemRoot ? path.join(env.SystemRoot, "System32", "reg.exe") : "reg";
      const output = execFileSync(executable, ["query", key, "/v", valueName], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const match = output.match(new RegExp(`${valueName}\\s+REG_\\w+\\s+(.+)`, "i"));
      const root = normalizeExistingPath(match?.[1]?.trim());
      if (root) {
        return root;
      }
    } catch {
      // Registry keys vary between Steam installations; try the next key.
    }
  }

  return null;
}

function detectWindowsSteamRootFromProgramFiles(env) {
  const drive = env.SystemRoot ? path.win32.parse(env.SystemRoot).root : null;
  const baseDirs = [env["ProgramFiles(x86)"], env.ProgramFiles,
    ...(drive ? [path.win32.join(drive, "Program Files (x86)"), path.win32.join(drive, "Program Files")] : [])].filter(Boolean);
  for (const baseDir of baseDirs) {
    const root = normalizeExistingPath(path.join(baseDir, "Steam"));
    if (root) {
      return root;
    }
  }
  return null;
}

function normalizeExistingPath(value) {
  if (!value || !String(value).trim()) {
    return null;
  }
  const normalized = path.normalize(String(value).trim());
  return existsSync(normalized) ? normalized : null;
}

