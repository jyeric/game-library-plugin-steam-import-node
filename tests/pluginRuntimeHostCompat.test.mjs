import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { launchSteamLogin } from '../src/auth/launchLogin.mjs';
import { handleAction } from '../src/jsonrpc/handleAction.mjs';
import { sessionFilePath, tokenCacheFilePath, steamSessionStatus, writeJsonPrivate } from '../src/steam/session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/Steam');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(path.join(tmpdir(), 'steam-jsonrpc1-')); dirs.push(dir); return dir; }
const init = (params = {}) => ({ jsonrpc: '2.0', id: 'init', method: 'plugin.initialize', params: { protocolVersion: 1, pluginId: manifest.id, ...params } });
const invoke = (action, input = {}, params = {}) => ({ jsonrpc: '2.0', id: 'run', method: 'action.invoke', params: { action, input, invocationId: 'fixture-invocation', operationKey: 'fixture-operation', ...params } });
function run(frames, { dataDir = temp(), preload = '', clearEnv = false } = {}) {
  const args = preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : [];
  const result = spawnSync(process.execPath, [...args, path.join(root, 'runtime/provider.mjs')], {
    cwd: path.join(root, 'runtime'), timeout: 10000, maxBuffer: 3 * 1024 * 1024,
    input: frames.map(frame => typeof frame === 'string' ? frame : JSON.stringify(frame)).join('\n') + '\n',
    env: { ...(clearEnv ? { SystemRoot: process.env.SystemRoot } : process.env), GAME_LIBRARY_PLUGIN_DATA_DIR: dataDir, STEAM_ROOT: fixture },
  });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout.toString().trim().split(/\r?\n/).map(line => JSON.parse(line));
}

describe('json-rpc/1 host compatibility', () => {
  it('negotiates every declared action and returns direct results', () => {
    const [initialized, result] = run([init(), invoke('detect-libraries')], { clearEnv: true });
    assert.deepEqual(initialized.result, { protocolVersion: 1, pluginId: manifest.id, actions: manifest.actions.map(a => a.id) });
    assert.equal(result.id, 'run');
    assert.equal(result.result.providerId, 'community.steam_import_node.import');
    assert.equal(result.result.libraries[0].manifestCount, 2);
    assert.equal(result.result.hostApi, undefined);
  });
  it('discovers selected libraries using the actual import.input/1 shape', () => {
    const [, result] = run([init(), invoke('discover', { providerId: 'community.steam_import_node.import', input: { 'selected-libraries': { paths: [fixture] } }, schema: 'import.input/1' })]);
    assert.equal(result.result.candidates.length, 2);
    const game = result.result.candidates.find(c => c.externalIds.steam === '730');
    assert.equal(game.launchConfiguration[0].value, 'steam://rungameid/730');
    assert.equal(game.launchConfiguration[0].tracking.installDirectory, game.path);
  });
  it('supports default discovery and existing read-candidates domain calls', () => {
    for (const action of ['discover', 'read-candidates']) {
      const [, result] = run([init(), invoke(action)]);
      assert.equal(result.result.candidates.length, 2);
    }
  });
  it('returns status without credentials or mutating approved code', () => {
    const before = readFileSync(path.join(root, 'manifest.json'));
    const [, result] = run([init(), invoke('account-status')]);
    assert.equal(result.result.loggedIn, false);
    assert.deepEqual(readFileSync(path.join(root, 'manifest.json')), before);
    assert.equal(existsSync(path.join(root, '.session')), false);
  });
  it('reports login required without opening a browser in background discovery', () => {
    const dataDir = temp();
    const [, result] = run([init(), invoke('read-account-candidates', { input: 'account' })], { dataDir });
    assert.match(result.error.message, /Steam browser login is required/);
    assert.equal(result.error.data.messageKey, 'error.providerLoginRequired');
    assert.equal(steamSessionStatus(dataDir).loggedIn, false);
  });
  it('imports owned and family-shared games via native fetch without retired host callbacks', () => {
    const dataDir = temp();
    writeJsonPrivate(sessionFilePath(dataDir), { cookies: [{ name: 'steamLoginSecure', value: 'fixture', domain: '.steampowered.com', path: '/' }] });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: '76561198000000001', exp: 4102444800 })).toString('base64url')}.fixture`;
    const preload = `globalThis.fetch = async url => {
      let body;
      if (String(url).includes('ajaxgetasyncconfig')) body = { webapi_token: ${JSON.stringify(token)} };
      else if (String(url).includes('GetOwnedGames')) body = { response: { games: [{ appid: 10, name: 'Owned' }] } };
      else if (String(url).includes('GetFamilyGroupForUser')) body = { response: { family_groupid: '123' } };
      else if (String(url).includes('GetSharedLibraryApps')) body = { response: { apps: [{ appid: 30, name: 'Shared', owner_steamids: ['76561198000000003'], app_type: 1, exclude_reason: 0 }] } };
      else throw new Error('Unexpected network request');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };`;
    const frames = run([init(), invoke('read-account-candidates', { input: 'account' })], { dataDir, preload });
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[1].result.candidates.map(c => c.externalIds.steam), ['10', '30']);
    assert.ok(existsSync(tokenCacheFilePath(dataDir)));
  });
  it('starts login with the managed interpreter and persistent root', async () => {
    let args;
    await launchSteamLogin((...values) => {
      args = values;
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('spawn')); return child;
    }, 'C:/fixture/edge.exe');
    assert.equal(args[0], process.execPath);
    assert.ok(args[1][0].endsWith('steam-auth.mjs'));
    assert.equal(args[1][3], path.dirname(sessionFilePath()));
    assert.equal(args[2].windowsHide, true);
    await assert.rejects(launchSteamLogin(() => {
      const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('spawn failed'))); return child;
    }, 'C:/fixture/edge.exe'), /spawn failed/);
    await assert.rejects(launchSteamLogin(undefined, null), /Edge or Chrome was not found/);
  });
  it('returns pending login over the wire and marks failed starts recoverable', async () => {
    const dataDir = temp();
    const preload = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {EventEmitter} from 'node:events';
      cp.spawn = () => { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; }; syncBuiltinESMExports();`;
    const [, result] = run([init(), invoke('login')], { dataDir, preload });
    assert.equal(result.result.pending, true);
    assert.equal(steamSessionStatus(dataDir).pending, true);
    const prior = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR;
    process.env.GAME_LIBRARY_PLUGIN_DATA_DIR = dataDir;
    try {
      const response = await handleAction('failed-login', { actionId: 'login' }, { launchLogin: async () => { throw new Error('spawn failed'); } });
      assert.equal(response.error.message, 'spawn failed');
      assert.equal(steamSessionStatus(dataDir).pending, undefined);
    } finally { if (prior === undefined) delete process.env.GAME_LIBRARY_PLUGIN_DATA_DIR; else process.env.GAME_LIBRARY_PLUGIN_DATA_DIR = prior; }
  });
  it('clears pending login if the detached helper fails before opening its browser', () => {
    const dataDir = temp();
    writeJsonPrivate(path.join(dataDir, 'steam-login-state.json'), { state: 'pending', startedAt: new Date().toISOString() });
    const child = spawnSync(process.execPath, [path.join(root, 'src/auth/steam-auth.mjs'), 'invalid', '--data-dir', dataDir], { timeout: 5000 });
    assert.equal(child.status, 1);
    assert.equal(steamSessionStatus(dataDir).pending, undefined);
    assert.equal(steamSessionStatus(dataDir).loggedIn, false);
  });
  it('resolves current launch option values and refuses missing Steam identities', () => {
    const [, resolution, launch, invalid] = run([init(), invoke('resolve-launch', { option: { value: 'steam://rungameid/730' } }), invoke('request-launch', { game: { externalIds: { steam: '730' } } }), invoke('request-launch')]);
    assert.equal(resolution.result.canHandle, true);
    assert.equal(launch.result.url, 'steam://rungameid/730');
    assert.ok(invalid.error);
  });
  it('rejects malformed frames, old methods, invalid negotiation and undeclared invocations', () => {
    const frames = run(['{', null, { jsonrpc: '1.0', id: 1 }, invoke('detect-libraries'), init({ protocolVersion: 2 }), init({ pluginId: 'wrong' }), init(), init(), invoke('missing'), invoke('detect-libraries', {}, { invocationId: '' }), invoke('detect-libraries', {}, { operationKey: '' }), { jsonrpc: '2.0', id: 2, method: 'executeAction' }, invoke('discover', { input: { 'selected-libraries': { paths: [] } } }), invoke('discover', { input: { 'selected-libraries': { paths: [''] } } }), invoke('discover', { input: { 'selected-libraries': { paths: 'bad' } } })]);
    assert.equal(frames.filter(frame => frame.result).length, 1);
    assert.ok(frames.filter(frame => frame.error).length >= 13);
  });
});
