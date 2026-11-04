'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {createCloudSync} = require('../src/cloud-sync.cjs');
const SHA = 'da41f4969f915076c61d4e3bc80a0e1679344f833ac5ede4f70b2a9217e53547';
const digest = bytes => crypto.createHash('sha1').update(bytes).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value));
function saves(progress, ids = [1], settings = 'normal') {
  const files = {}, meta = {};
  for (const id of ids) {
    const name = `Default/Save_ID_${String(id).padStart(4, '0')}.save`;
    files[name] = bytes({sub: {progress}, meta: {progress}, vars: {progress}});
    meta[id] = {id, time: 1, sub: {progress}};
  }
  files['Default/System.save'] = bytes({lastUsedID: ids[0], lastUsedManualID: 1, sub: {settings}, meta});
  return files;
}
async function writeSet(folder, files) {
  for (const [name, buffer] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(folder, name)), {recursive: true});
    await fs.writeFile(path.join(folder, name), buffer);
  }
}
async function readSet(folder) {
  const files = {};
  for (const generation of ['Default', 'Backups', 'Backups2']) {
    const dir = path.join(folder, generation);
    for (const name of await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; }))
      if (name.endsWith('.save')) files[`${generation}/${name}`] = await fs.readFile(path.join(dir, name));
  }
  return files;
}
const cache = files => Object.fromEntries(Object.entries(files).map(([name, buffer]) => [name, {sha1: digest(buffer), size: buffer.length}]));
async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'alabaster-cloud-test-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const root = path.join(temp, 'launcher'), steamProfile = path.join(temp, 'SteamProfile');
  const nativeDataPath = path.join(root, 'profile/Default');
  await fs.mkdir(root);
  const paths = {steam: path.join(steamProfile, 'Saves'), native: path.join(root, 'profile/Saves')};
  const ctx = {variant: 'full', bundleSha256: SHA, gameDir: path.join(temp, 'original'), steamProfile, nativeDataPath};
  const state = {account: '12345', busy: false, available: true, remote: saves(9), calls: [], down: null, up: null, cache: null};
  const adapter = {
    async status() { return {available: state.available, reason: 'Offline', accountId: state.account, appId: 3110760}; },
    async sync(direction, progress) {
      state.calls.push(direction);
      progress?.({message: 'Mock adapter progress'});
      if (direction === 'down') {
        if (state.down) await state.down();
        for (const name of Object.keys(await readSet(paths.steam))) if (!state.remote[name]) await fs.unlink(path.join(paths.steam, name));
        await writeSet(paths.steam, state.remote);
      } else {
        if (state.up) await state.up();
        state.remote = await readSet(paths.steam);
      }
      return {accountId: state.account, result: 'ok', files: state.cache || cache(state.remote)};
    },
  };
  const create = () => createCloudSync({root, context: () => ctx, isBusy: async () => state.busy, steam: adapter});
  const api = create();
  await writeSet(paths.native, options.native || saves(3));
  await writeSet(paths.steam, options.steam || state.remote);
  return {temp, root, paths, ctx, state, api, create};
}

test('Steam account marker survives upload and never enters copied files or backups', async t => {
  const f = await fixture(t);
  const marker = path.join(f.paths.steam, 'steam_autocloud.vdf');
  const content = '"steam_autocloud.vdf" { "accountid" "12345" }';
  await fs.writeFile(marker, content);
  const p = await f.api.preview('upload');
  assert.equal(p.fileCount, 2);
  const result = await f.api.sync(p.token);
  assert.equal(await fs.readFile(marker, 'utf8'), content);
  assert.equal(Object.hasOwn(f.state.remote, 'steam_autocloud.vdf'), false);
  for (const backup of result.backupPaths) {
    const record = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
    assert.equal(Object.hasOwn(record.files, 'steam_autocloud.vdf'), false);
  }
});

test('malformed and linked Steam markers are rejected before synchronization', async t => {
  const f = await fixture(t), marker = path.join(f.paths.steam, 'steam_autocloud.vdf');
  await fs.writeFile(marker, 'not a Steam marker');
  await assert.rejects(f.api.preview('upload'), /metadata|marker/);
  await fs.unlink(marker);
  await fs.symlink(path.join(f.paths.steam, 'Default/System.save'), marker);
  await assert.rejects(f.api.preview('upload'), /linked/);
  assert.deepEqual(f.state.calls, []);
});

test('preview refreshes Steam but leaves native bytes untouched; confirmation replaces and backs up full native set', async t => {
  const old = saves(3, [1, 7], 'native');
  old['Backups/System.save'] = old['Default/System.save'];
  const f = await fixture(t, {native: old});
  await fs.writeFile(path.join(f.paths.native, 'notes.txt'), 'preserve');
  const p = await f.api.preview('download');
  assert.deepEqual(await readSet(f.paths.native), old);
  assert.equal(p.fileCount, 2); assert.equal(p.changedCount, 4);
  assert.match(p.warning, /Local-only saves are removed after backup/);
  assert.match(p.warning, /Unrecognized native files are kept/);
  const r = await f.api.sync(p.token);
  assert.deepEqual(await readSet(f.paths.native), f.state.remote);
  assert.equal(await fs.readFile(path.join(f.paths.native, 'notes.txt'), 'utf8'), 'preserve');
  const nativeBackup = r.backupPaths.find(p => p.endsWith('native-before-download'));
  assert.deepEqual(await readSet(path.join(nativeBackup, 'files')), old);
  assert.deepEqual(f.state.calls, ['down', 'down']);
  assert.equal((await f.api.status()).recoveryRequired, false);
});

test('upload stages native bytes, verifies Cloud cache and backs up the old Steam set', async t => {
  const f = await fixture(t), remote = f.state.remote;
  const native = await readSet(f.paths.native);
  const p = await f.api.preview('upload');
  const r = await f.api.sync(p.token);
  assert.deepEqual(f.state.remote, native);
  assert.deepEqual(await readSet(f.paths.steam), native);
  assert.deepEqual(await readSet(path.join(r.backupPaths.find(p => p.endsWith('steam-before-upload')), 'files')), remote);
  assert.deepEqual(f.state.calls, ['down', 'down', 'up']);
});

test('upload never implicitly deletes Cloud-only save files', async t => {
  const f = await fixture(t);
  f.state.remote = saves(9, [1, 7]);
  await assert.rejects(f.api.preview('upload'), /Cloud has saves missing from ARM64/);
  assert.deepEqual(f.state.calls, ['down']);
});

test('empty Cloud and index-only Cloud cannot erase native progress', async t => {
  const f = await fixture(t), before = await readSet(f.paths.native);
  f.state.remote = {};
  await assert.rejects(f.api.preview('download'), /Empty Cloud data/);
  f.state.remote = {'Default/System.save': saves(1)['Default/System.save']};
  await assert.rejects(f.api.preview('download'), /Empty Cloud data/);
  assert.deepEqual(await readSet(f.paths.native), before);
});

test('one-use tokens are required, preview replacement invalidates older token', async t => {
  const f = await fixture(t);
  await assert.rejects(f.api.sync('invented'), /Preview and confirm/);
  const p = await f.api.preview('download');
  await f.api.preview('upload');
  await assert.rejects(f.api.sync(p.token), /Preview and confirm/);
  await assert.rejects(f.api.sync(p.token), /Preview and confirm/);
  const next = await f.api.preview('download');
  await assert.rejects(f.api.sync({token: next.token}), /Preview and confirm/);
});

test('account change at confirmation prevents local writes and new sync', async t => {
  const f = await fixture(t), old = await readSet(f.paths.native);
  const p = await f.api.preview('download'); f.state.account = '999';
  await assert.rejects(f.api.sync(p.token), /account changed/);
  assert.deepEqual(await readSet(f.paths.native), old);
  assert.deepEqual(f.state.calls, ['down']);
});

test('account changed by adapter during download is rejected', async t => {
  const f = await fixture(t), old = await readSet(f.paths.native);
  f.state.down = async () => { f.state.account = '999'; };
  await assert.rejects(f.api.preview('download'), /account changed/);
  assert.deepEqual(await readSet(f.paths.native), old);
});

test('local native or Steam byte changes invalidate confirmation before refresh', async t => {
  const f = await fixture(t);
  let p = await f.api.preview('download');
  await writeSet(f.paths.native, saves(4));
  await assert.rejects(f.api.sync(p.token), /changed after the preview/);
  p = await f.api.preview('download'); await writeSet(f.paths.steam, saves(7));
  await assert.rejects(f.api.sync(p.token), /changed after the preview/);
  assert.deepEqual(f.state.calls, ['down', 'down']);
});

test('remote changed since preview is refreshed, then aborts without native overwrite', async t => {
  const f = await fixture(t), old = await readSet(f.paths.native);
  const p = await f.api.preview('download'); f.state.remote = saves(12);
  await assert.rejects(f.api.sync(p.token), /Cloud or native saves changed/);
  assert.deepEqual(await readSet(f.paths.native), old);
  assert.deepEqual(await readSet(f.paths.steam), f.state.remote);
});

test('mtime-only refresh does not falsely invalidate byte-identical confirmation', async t => {
  const f = await fixture(t), p = await f.api.preview('download');
  const file = path.join(f.paths.steam, 'Default/System.save');
  await fs.utimes(file, new Date(1), new Date(1));
  await f.api.sync(p.token);
  assert.deepEqual(await readSet(f.paths.native), f.state.remote);
});

test('busy game and changed full-game context fail closed', async t => {
  const f = await fixture(t); f.state.busy = true;
  await assert.rejects(f.api.preview('download'), /Close both versions/);
  f.state.busy = false; const p = await f.api.preview('download');
  f.ctx.gameDir += '-changed';
  await assert.rejects(f.api.sync(p.token), /Game setup changed/);
  f.ctx.variant = 'demo'; assert.equal((await f.api.status()).available, false);
});

test('adapter conflicts leave native untouched and preserve the pre-download Steam backup', async t => {
  const f = await fixture(t), old = await readSet(f.paths.native), steamBefore = await readSet(f.paths.steam);
  f.state.down = async () => { throw Object.assign(new Error('Resolve the Steam conflict first.'), {quiescent: true}); };
  await assert.rejects(f.api.preview('download'), error => {
    assert.match(error.message, /Steam conflict/); assert.ok(error.backupPaths.length); return true;
  });
  assert.deepEqual(await readSet(f.paths.native), old);
  assert.deepEqual(await readSet(f.paths.steam), steamBefore);
  assert.equal((await f.api.status()).recoveryRequired, false);
});

test('unknown download completion records recovery and blocks manual retry', async t => {
  const f = await fixture(t);
  f.state.down = async () => { throw new Error('Steam operation timed out'); };
  await assert.rejects(f.api.preview('download'), /timed out/);
  assert.equal((await f.api.status()).recoveryRequired, true);
  await assert.rejects(f.api.preview('download'), /uncertain result/);
});

test('uncertain upload retains staging and backup, warns about partial remote and exit sync', async t => {
  const f = await fixture(t), native = await readSet(f.paths.native), oldCloud = f.state.remote;
  const p = await f.api.preview('upload');
  f.state.up = async () => {
    f.state.remote = {...oldCloud, 'Default/System.save': native['Default/System.save']};
    throw new Error('Connection lost during upload');
  };
  await assert.rejects(f.api.sync(p.token), error => {
    assert.match(error.message, /may already contain some uploaded/);
    assert.match(error.message, /closing the launcher may trigger/);
    assert.ok(error.backupPaths.some(p => p.endsWith('steam-before-upload'))); return true;
  });
  assert.deepEqual(await readSet(f.paths.steam), native);
  assert.equal((await f.api.status()).recoveryRequired, true);
  await assert.rejects(f.api.preview('upload'), /uncertain result/);
});

test('terminal idle upload failure restores previous Steam bytes without remote rollback claims', async t => {
  const f = await fixture(t), old = await readSet(f.paths.steam);
  const p = await f.api.preview('upload');
  f.state.up = async () => { throw Object.assign(new Error('Steam rejected upload'), {quiescent: true}); };
  await assert.rejects(f.api.sync(p.token), /restored locally; the remote result still needs checking/);
  assert.deepEqual(await readSet(f.paths.steam), old);
  assert.equal((await f.api.status()).recoveryRequired, false);
});

test('terminal failure does not overwrite Steam bytes changed outside owned staging', async t => {
  const f = await fixture(t), outside = saves(55);
  const p = await f.api.preview('upload');
  f.state.up = async () => { await writeSet(f.paths.steam, outside); throw Object.assign(new Error('Failed'), {quiescent: true}); };
  await assert.rejects(f.api.sync(p.token), /Staged Steam files and backups were retained/);
  assert.deepEqual(await readSet(f.paths.steam), outside);
  assert.equal((await f.api.status()).recoveryRequired, true);
});

test('false adapter cache success cannot confirm download or upload', async t => {
  const f = await fixture(t), old = await readSet(f.paths.native);
  f.state.cache = cache(saves(77));
  await assert.rejects(f.api.preview('download'), /do not match/);
  assert.deepEqual(await readSet(f.paths.native), old);
  f.state.cache = null; const p = await f.api.preview('upload');
  f.state.up = async () => { f.state.cache = cache(saves(77)); };
  await assert.rejects(f.api.sync(p.token), /do not match/);
  assert.equal((await f.api.status()).recoveryRequired, true);
});

test('Steam unknown files block before adapter, native unknown files are preserved', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.paths.steam, 'surprise.txt'), 'not a save');
  await assert.rejects(f.api.preview('download'), /unrecognized files/);
  assert.deepEqual(f.state.calls, []);
});

test('symlinked saves and save directories fail closed', async t => {
  const f = await fixture(t), save = path.join(f.paths.native, 'Default/Save_ID_0001.save');
  await fs.rename(save, save + '.real'); await fs.symlink(save + '.real', save);
  await assert.rejects(f.api.preview('download'), /linked/);
  await fs.unlink(save); await fs.rename(save + '.real', save);
  const original = f.paths.steam + '-real';
  await fs.rename(f.paths.steam, original); await fs.symlink(original, f.paths.steam);
  await assert.rejects(f.api.preview('download'), /linked or invalid/);
});

test('oversized and malformed source saves are rejected before native replacement', async t => {
  const f = await fixture(t), target = path.join(f.paths.native, 'Default/Save_ID_0001.save');
  const handle = await fs.open(target, 'w'); await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(f.api.preview('upload'), /supported transfer size/);
  await fs.writeFile(target, '{broken');
  await assert.rejects(f.api.preview('upload'), /not readable/);
  assert.deepEqual(f.state.calls, []);
});

test('unindexed current source saves cannot be copied as a coherent Cloud set', async t => {
  const f = await fixture(t);
  f.state.remote['Default/System.save'] = bytes({lastUsedID: 1, sub: {}, meta: {}});
  await assert.rejects(f.api.preview('download'), /not indexed correctly/);
});

test('two coordinator instances share the operation lock; progress exceptions do not escape', async t => {
  const f = await fixture(t), other = f.create();
  let unblock, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.state.down = () => new Promise(resolve => { unblock = resolve; entered(); });
  const one = f.api.preview('download', () => { throw new Error('UI callback failed'); });
  await ready;
  await assert.rejects(other.preview('download'), /Another Cloud operation/);
  assert.equal((await other.status()).busy, true);
  unblock(); await one;
  assert.equal((await other.status()).busy, false);
});

test('a failure after multiple local file replacements rolls back native bytes and removal', async t => {
  const f = await fixture(t, {native: saves(3, [1, 7])});
  f.state.remote = saves(9, [1, 2]);
  const old = await readSet(f.paths.native), p = await f.api.preview('download');
  const originalRename = fs.rename;
  let writes = 0;
  fs.rename = async (from, to) => {
    if (to.startsWith(f.paths.native + path.sep) && ++writes === 3) throw new Error('Injected publish failure');
    return originalRename(from, to);
  };
  try { await assert.rejects(f.api.sync(p.token), /Injected publish failure/); }
  finally { fs.rename = originalRename; }
  assert.deepEqual(await readSet(f.paths.native), old);
  assert.equal((await f.api.status()).recoveryRequired, false);
});

test('new save files are never staged under the Steam Auto-Cloud watched directory', async t => {
  const f = await fixture(t), p = await f.api.preview('upload');
  const originalRename = fs.rename, staging = [];
  fs.rename = async (from, to) => { if (to.startsWith(f.paths.steam + path.sep)) staging.push(from); return originalRename(from, to); };
  try { await f.api.sync(p.token); } finally { fs.rename = originalRename; }
  assert.ok(staging.length);
  assert.ok(staging.every(name => !name.startsWith(f.paths.steam + path.sep)));
});

test('identical Cloud and native sets avoid upload and preserve files exactly', async t => {
  const f = await fixture(t, {native: saves(9)}), p = await f.api.preview('upload');
  assert.equal(p.unchanged, true);
  const r = await f.api.sync(p.token);
  assert.match(r.message, /already match/);
  assert.deepEqual(f.state.calls, ['down', 'down']);
});

test('a second destination changed during the first write is preserved and prior owned write is rolled back', async t => {
  const f = await fixture(t, {native: saves(3, [1, 2])});
  f.state.remote = saves(9, [1, 2]);
  const old = await readSet(f.paths.native), p = await f.api.preview('download');
  const originalRename = fs.rename, changedPath = 'Default/Save_ID_0002.save', external = saves(88, [2])[changedPath];
  let injected = false;
  fs.rename = async (from, to) => {
    const result = await originalRename(from, to);
    if (!injected && to === path.join(f.paths.native, 'Default/Save_ID_0001.save')) {
      injected = true; await fs.writeFile(path.join(f.paths.native, changedPath), external);
    }
    return result;
  };
  try { await assert.rejects(f.api.sync(p.token), /Save changed during the transfer/); }
  finally { fs.rename = originalRename; }
  assert.deepEqual(await readSet(f.paths.native), {...old, [changedPath]: external});
});

test('rollback never overwrites a new external value in an already published file', async t => {
  const f = await fixture(t, {native: saves(3, [1, 2])});
  f.state.remote = saves(9, [1, 2]);
  const p = await f.api.preview('download'), originalRename = fs.rename;
  const firstPath = 'Default/Save_ID_0001.save', external = saves(88)[firstPath];
  fs.rename = async (from, to) => {
    if (to === path.join(f.paths.native, 'Default/Save_ID_0002.save')) {
      await fs.writeFile(path.join(f.paths.native, firstPath), external);
      throw new Error('Injected second publication failure');
    }
    return originalRename(from, to);
  };
  try { await assert.rejects(f.api.sync(p.token), error => { assert.ok(error.rollbackFailed.length); return true; }); }
  finally { fs.rename = originalRename; }
  assert.deepEqual(await fs.readFile(path.join(f.paths.native, firstPath)), external);
  assert.equal((await f.api.status()).recoveryRequired, true);
});

test('removal failure restores previously removed local-only files', async t => {
  const f = await fixture(t, {native: saves(3, [1, 7, 8])});
  const old = await readSet(f.paths.native), p = await f.api.preview('download'), originalUnlink = fs.unlink;
  fs.unlink = async name => {
    if (name === path.join(f.paths.native, 'Default/Save_ID_0008.save')) throw new Error('Injected remove failure');
    return originalUnlink(name);
  };
  try { await assert.rejects(f.api.sync(p.token), /Injected remove failure/); }
  finally { fs.unlink = originalUnlink; }
  assert.deepEqual(await readSet(f.paths.native), old);
});

test('Cloud path traversal and wrong app identity cannot be accepted', async t => {
  const f = await fixture(t);
  f.state.cache = {'../outside.save': {sha1: '0'.repeat(40), size: 0}};
  await assert.rejects(f.api.preview('download'), /unsupported save paths/);
  const wrong = createCloudSync({root: f.root, context: () => f.ctx, isBusy: async () => false,
    steam: {status: async () => ({available: true, accountId: '12345', appId: 3900710}), sync: async () => assert.fail('must not sync')}});
  await assert.rejects(wrong.preview('download'), /identity could not be checked/);
});
