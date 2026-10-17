import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { findBrowserExecutable } from '../src/auth/browserExecutable.mjs';
import { detectSteamRoot } from '../src/steam/detectSteamRoot.mjs';
import { sessionFilePath } from '../src/steam/session.mjs';

describe('clean native process environment', () => {
  it('finds browsers from OS locations without inherited application variables', () => {
    const calls = [];
    const found = findBrowserExecutable({ platform: 'win32', env: { SystemRoot: 'D:\\Windows' }, home: 'D:/Users/test', exists: value => { calls.push(value); return value.endsWith('chrome.exe'); } });
    assert.ok(found.endsWith('chrome.exe'));
    assert.ok(calls.every(value => value.startsWith('D:')));
    assert.equal(findBrowserExecutable({ platform: 'win32', env: { MSEDGE: 'custom-edge' }, exists: value => value === 'custom-edge' }), 'custom-edge');
    assert.equal(findBrowserExecutable({ platform: 'win32', env: {}, exists: () => false }), undefined);
    assert.equal(findBrowserExecutable({ platform: 'linux' }), undefined);
    const local = findBrowserExecutable({ platform: 'win32', env: { LOCALAPPDATA: 'E:/Local', ProgramFiles: 'E:/Apps', 'ProgramFiles(x86)': 'E:/Apps32' }, exists: value => value.startsWith(path.normalize('E:/Local')) });
    assert.ok(local.startsWith(path.normalize('E:/Local')));
  });
  it('uses a persistent session path outside approved code', () => {
    const prior = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR;
    delete process.env.GAME_LIBRARY_PLUGIN_DATA_DIR;
    try { assert.equal(sessionFilePath(), path.join(homedir(), '.game-library-steam', 'steam-session.json')); }
    finally { if (prior !== undefined) process.env.GAME_LIBRARY_PLUGIN_DATA_DIR = prior; }
  });
  it('uses the absolute registry utility and hides its window', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'steam-registry-'));
    try {
      const result = detectSteamRoot({ platform: 'win32', env: { SystemRoot: 'C:/Windows' }, execFileSync: (exe, args, options) => {
        assert.equal(exe, path.join('C:/Windows', 'System32', 'reg.exe'));
        assert.equal(options.windowsHide, true);
        return `SteamPath    REG_SZ    ${root}`;
      } });
      assert.equal(result.root, path.normalize(root));
      assert.equal(result.source, 'windows-registry');
      assert.equal(detectSteamRoot({ platform: 'linux', env: {} }).root, null);
      assert.equal(detectSteamRoot({ platform: 'win32', env: {}, execFileSync: () => { throw new Error('missing'); } }).root, null);
      mkdirSync(path.join(root, 'Steam'));
      assert.equal(detectSteamRoot({ platform: 'win32', env: { ProgramFiles: root }, execFileSync: () => '' }).source, 'program-files');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
