'use strict';
// Real adapter/coordinator; disposable files and an in-process Steam CDP mock.
// No Steam connection, real save access, or Cloud operation is performed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {createSteamCloud, parseVDF} = require('../src/steam-cloud.cjs');
const {createCloudSync} = require('../src/cloud-sync.cjs');
const SHA = 'da41f4969f915076c61d4e3bc80a0e1679344f833ac5ede4f70b2a9217e53547';
const digest = bytes => crypto.createHash('sha1').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));
function saves(ids = ['auto', 3], progress = 30) {
  const files = {}, meta = {};
  for (const id of ids) {
    const suffix = id === 'auto' ? id : String(id).padStart(4, '0');
    files[`Default/Save_ID_${suffix}.save`] = json({vars:{progress}, sub:{progress}, meta:{progress}});
    meta[id] = {id, sub:{progress}};
  }
  files['Default/System.save'] = json({lastUsedID:ids[0], sub:{settings:'native'}, meta});
  return files;
}
function writeSet(directory, files) {
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive:true});
    fs.writeFileSync(path.join(directory, name), bytes);
  }
}
function readSet(directory) {
  const files = {};
  for (const generation of ['Default', 'Backups', 'Backups2']) {
    const folder = path.join(directory, generation);
    if (fs.existsSync(folder)) for (const name of fs.readdirSync(folder).sort())
      if (name.endsWith('.save')) files[`${generation}/${name}`] = fs.readFileSync(path.join(folder, name));
  }
  return files;
}
function rewriteCache(fixture, mutate) {
  const data = parseVDF(fs.readFileSync(fixture.cache, 'utf8'));
  mutate(data['3110760']);
  const serialize = value => Object.entries(value).map(([key, item]) =>
    `${JSON.stringify(key)} ${typeof item === 'string' ? JSON.stringify(item) : '{\n' + serialize(item) + '\n}'}`).join('\n');
  fs.writeFileSync(fixture.cache, serialize(data));
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alabaster-local-copy-cloud-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  const root = path.join(home, 'launcher'), steam = path.join(home, '.local/share/Steam');
  const profile = path.join(home, '.config/Alabaster Dawn'), steamSaves = path.join(profile, 'Saves');
  const native = path.join(root, 'profile/Saves'), game = path.join(steam, 'steamapps/common/Alabaster Dawn');
  const cache = path.join(steam, 'userdata/12345/3110760/remotecache.vdf');
  const log = path.join(steam, 'logs/cloud_log.txt');
  for (const folder of [root, game, path.dirname(cache), path.dirname(log), path.join(steam, 'config')]) fs.mkdirSync(folder, {recursive:true});
  fs.writeFileSync(path.join(steam, 'config/loginusers.vdf'), '"users" { "76561197960278073" { "AccountName" "fixture" } }');
  fs.writeFileSync(log, '');
  writeSet(native, saves()); writeSet(steamSaves, saves());
  const state = {commands:[], down:'pending', up:'ok', remote:saves(['auto'], 10), change:6};
  function writeCache({synced=false, syncstate='3', mismatch=false, extra=[]} = {}) {
    const local = readSet(steamSaves);
    // Synthetic pending-copy state: System's cached hash matches the local
    // bytes, while the new slot is absent from the cache until upload.
    const names = synced ? Object.keys(local) : ['Default/Save_ID_auto.save', 'Default/System.save', ...extra];
    const entries = names.map(name => {
      const bytes = local[name] || Buffer.from('missing');
      return `${JSON.stringify(name)} { "root" "3" "size" "${bytes.length}" "sha" "${mismatch ? '0'.repeat(40) : digest(bytes)}" "syncstate" "${synced || name !== 'Default/System.save' ? '1' : syncstate}" "persiststate" "0" }`;
    });
    fs.writeFileSync(cache, `"3110760" { "ChangeNumber" "${state.change}" ${entries.join('\n')} }`);
  }
  writeCache();
  const ctx = {variant:'full', bundleSha256:SHA, gameDir:game, bundlePath:path.join(game,'bundle.js'), steamProfile:profile, nativeDataPath:path.join(root,'profile/Default')};
  const evaluate = async expression => {
    if (expression.includes('RegisterForAppDetails')) return {accountName:'fixture', loginState:5, folder:game, compatTool:'steamlinuxruntime', cloudEnabled:true, accountCloudEnabled:true, cloudProgress:0};
    const found = /cloud_sync_(down|up) 3110760/.exec(expression);
    assert.ok(found, 'Only checked identity or Cloud console commands are mocked');
    const direction = found[1], mode = state[direction]; state.commands.push(direction);
    let lines = `[AppID 3110760] Starting sync (${direction},AC Exit,)\n[AppID 3110760] AutoCloud checking local state for user 12345\n`;
    if (mode === 'timeout') { fs.appendFileSync(log, lines); return true; }
    if (mode === 'overlap') lines += `[AppID 3110760] Starting sync (${direction},AC Exit,)\n`;
    if (mode === 'conflict') lines += '[AppID 3110760] Local and remote save conflict\n';
    if (direction === 'up' && mode === 'ok') { state.remote = readSet(steamSaves); state.change++; writeCache({synced:true}); }
    lines += direction === 'down' ? '[AppID 3110760] Need to upload file Default/System.save\n[AppID 3110760] Need to upload file Default/Save_ID_0003.save\n[AppID 3110760] Download complete in build list\n' : '[AppID 3110760] Upload complete, result OK\n';
    lines += '[AppID 3110760] YldWriteCacheDirectoryToFile - saved to fixture\n';
    fs.appendFileSync(log, lines); return true;
  };
  const adapter = createSteamCloud({home, context:()=>ctx, evaluate, timeout:100, interval:1, originalEntry:false});
  const api = createCloudSync({root, context:()=>ctx, isBusy:async()=>false, steam:adapter});
  return {root, native, steamSaves, cache, state, adapter, api, writeCache};
}
async function noRecovery(f) {
  assert.equal(fs.existsSync(path.join(f.root, 'cloud-recovery.json')), false);
  assert.equal((await f.api.status()).recoveryRequired, false);
}

test('completed down recognizes dirty existing metadata plus a newly copied uncached slot', async t => {
  const f = fixture(t), result = await f.adapter.sync('down');
  assert.equal(result.result, 'pending-local');
  assert.deepEqual(result.pendingFiles, ['Default/Save_ID_0003.save', 'Default/System.save']);
  assert.equal(result.cachePaths.includes('Default/Save_ID_0003.save'), false);
  assert.equal(result.files['Default/Save_ID_0003.save'].sha1, digest(readSet(f.native)['Default/Save_ID_0003.save']));
  assert.match(result.cacheToken, /^[a-f0-9]{64}$/);
  await noRecovery(f);
});

test('matching local copies still require confirmed upload and final synchronized cache', async t => {
  const f = fixture(t), original = readSet(f.native), oldRemote = f.state.remote;
  const preview = await f.api.preview('upload');
  assert.equal(preview.pendingUpload, true); assert.equal(preview.unchanged, false); assert.equal(preview.changedCount, 0);
  assert.equal(preview.destinationDate, null); assert.match(preview.warning, /pending|waiting to upload/i);
  assert.deepEqual(f.state.commands, ['down']); assert.deepEqual(f.state.remote, oldRemote);
  const result = await f.api.sync(preview.token);
  assert.match(result.message, /uploaded/i); assert.deepEqual(f.state.commands, ['down','down','up']);
  assert.deepEqual(f.state.remote, original); assert.deepEqual(readSet(f.steamSaves), original); assert.deepEqual(readSet(f.native), original);
  assert.ok(result.backupPaths.some(folder => folder.endsWith('steam-before-upload')));
  await noRecovery(f);
});

test('state-3 metadata may retain an earlier hash after another local edit', async t => {
  const f = fixture(t), name = 'Default/System.save';
  const revised = json({...JSON.parse(readSet(f.native)[name]), lastUsedID:3, sub:{settings:'later local edit'}});
  writeSet(f.steamSaves, {[name]:revised}); writeSet(f.native, {[name]:revised});
  const pending = await f.adapter.sync('down');
  assert.equal(pending.result, 'pending-local'); assert.equal(pending.files[name].sha1, digest(revised));
  const preview = await f.api.preview('upload');
  assert.equal(preview.pendingUpload, true); assert.equal(preview.changedCount, 0); assert.equal(preview.unchanged, false);
  await f.api.sync(preview.token);
  assert.deepEqual(f.state.remote[name], revised); assert.deepEqual(f.state.commands, ['down','down','down','up']);
  await noRecovery(f);
});

test('state-1 cached hash mismatch is not excused by another new pending file', async t => {
  const f = fixture(t), name = 'Default/System.save'; f.writeCache({syncstate:'1'});
  writeSet(f.steamSaves, {[name]:json({...JSON.parse(readSet(f.steamSaves)[name]), sub:{settings:'unverified mismatch'}})});
  await assert.rejects(f.api.preview('upload'), error => error.quiescent === true && /differ|match|conflict/i.test(error.message));
  assert.deepEqual(f.state.commands, ['down']); await noRecovery(f);
});

test('Download refuses pending local changes without false recovery and allows a subsequent Upload preview', async t => {
  const f = fixture(t), native = readSet(f.native), steam = readSet(f.steamSaves);
  await assert.rejects(f.api.preview('download'), /waiting to upload|local changes/i);
  assert.deepEqual(readSet(f.native), native); assert.deepEqual(readSet(f.steamSaves), steam);
  assert.deepEqual(f.state.commands, ['down']); await noRecovery(f);
  assert.equal((await f.api.preview('upload')).pendingUpload, true); await noRecovery(f);
});

test('changed remote-cache metadata invalidates confirmation despite identical local bytes', async t => {
  const f = fixture(t), preview = await f.api.preview('upload'), native = readSet(f.native);
  f.state.change++; f.writeCache();
  await assert.rejects(f.api.sync(preview.token), /changed after the preview/i);
  assert.deepEqual(f.state.commands, ['down','down']); assert.deepEqual(readSet(f.native), native); await noRecovery(f);
});

test('cache key-order and whitespace changes preserve the pending-upload approval', async t => {
  const f = fixture(t), preview = await f.api.preview('upload');
  const serialize = value => Object.entries(value).reverse().map(([key, item]) =>
    `${JSON.stringify(key)}\n${typeof item === 'string' ? JSON.stringify(item) : '{\n' + serialize(item) + '\n}'}`).join('\n\n');
  fs.writeFileSync(f.cache, serialize(parseVDF(fs.readFileSync(f.cache, 'utf8'))));
  await f.api.sync(preview.token);
  assert.deepEqual(f.state.commands, ['down','down','up']); assert.deepEqual(f.state.remote, readSet(f.native)); await noRecovery(f);
});

test('OSType and per-file timestamp/platform bookkeeping changes preserve approval', async t => {
  const f = fixture(t);
  rewriteCache(f, data => {
    data.OSType = '-203';
    for (const value of Object.values(data)) if (typeof value === 'object')
      Object.assign(value, {localtime:'1001', time:'1000', platformstosync2:'-1'});
  });
  const preview = await f.api.preview('upload'), native = readSet(f.native);
  rewriteCache(f, data => {
    data.OSType = '-202';
    for (const value of Object.values(data)) if (typeof value === 'object')
      Object.assign(value, {localtime:'1010', time:'1009', platformstosync2:'4'});
  });
  await f.api.sync(preview.token);
  assert.deepEqual(f.state.commands, ['down','down','up']); assert.deepEqual(f.state.remote, native); await noRecovery(f);
});

test('state-3 cached hash and size refreshing to unchanged actual bytes preserves approval', async t => {
  const f = fixture(t), name = 'Default/System.save', actual = readSet(f.steamSaves)[name];
  rewriteCache(f, data => { data[name].sha = '1'.repeat(40); data[name].size = '1'; });
  const preview = await f.api.preview('upload');
  rewriteCache(f, data => { data[name].sha = digest(actual); data[name].size = String(actual.length); });
  await f.api.sync(preview.token);
  assert.deepEqual(f.state.commands, ['down','down','up']); assert.deepEqual(f.state.remote[name], actual); await noRecovery(f);
});

test('uncached local slot becoming a cached state-3 slot preserves approval', async t => {
  const f = fixture(t), preview = await f.api.preview('upload'), name = 'Default/Save_ID_0003.save', actual = readSet(f.steamSaves)[name];
  rewriteCache(f, data => { data[name] = {root:'3', size:String(actual.length), sha:digest(actual), syncstate:'3', persiststate:'0'}; });
  await f.api.sync(preview.token);
  assert.deepEqual(f.state.commands, ['down','down','up']); assert.deepEqual(f.state.remote[name], actual); await noRecovery(f);
});

test('pending-to-synchronized state transition invalidates an earlier pending approval', async t => {
  const f = fixture(t), preview = await f.api.preview('upload'), native = readSet(f.native);
  rewriteCache(f, data => { data['Default/System.save'].syncstate = '1'; });
  await assert.rejects(f.api.sync(preview.token), /changed after the preview/i);
  assert.deepEqual(f.state.commands, ['down','down']); assert.deepEqual(readSet(f.native), native); await noRecovery(f);
});

test('synchronized cache hash changing after preview still blocks upload', async t => {
  const f = fixture(t), preview = await f.api.preview('upload'), native = readSet(f.native);
  rewriteCache(f, data => { data['Default/Save_ID_auto.save'].sha = '1'.repeat(40); });
  await assert.rejects(f.api.sync(preview.token), error => error.quiescent === true && /differ|match/i.test(error.message));
  assert.deepEqual(f.state.commands, ['down','down']); assert.deepEqual(readSet(f.native), native); await noRecovery(f);
});

test('new local bytes after preview prevent refresh and upload', async t => {
  const f = fixture(t), preview = await f.api.preview('upload');
  writeSet(f.steamSaves, saves(['auto',3], 42));
  await assert.rejects(f.api.sync(preview.token), /changed after the preview/i);
  assert.deepEqual(f.state.commands, ['down']); assert.deepEqual(readSet(f.steamSaves), saves(['auto',3],42)); await noRecovery(f);
});

for (const scenario of ['unknown-state', 'hash-mismatch', 'cached-file-missing']) test(`completed down rejects ${scenario} without pretending an operation remains running`, async t => {
  const f = fixture(t), native = readSet(f.native);
  if (scenario === 'unknown-state') f.writeCache({syncstate:'5'});
  if (scenario === 'hash-mismatch') f.writeCache({mismatch:true});
  if (scenario === 'cached-file-missing') fs.unlinkSync(path.join(f.steamSaves,'Default/Save_ID_auto.save'));
  await assert.rejects(f.api.preview('upload'), error => error.quiescent === true);
  assert.deepEqual(f.state.commands, ['down']); assert.deepEqual(readSet(f.native), native); await noRecovery(f);
});

test('pending Steam-only slots cannot be deleted by uploading a smaller native set', async t => {
  const f = fixture(t); writeSet(f.steamSaves, saves(['auto',3,7])); f.writeCache({extra:['Default/Save_ID_0007.save']});
  const steam = readSet(f.steamSaves);
  await assert.rejects(f.api.preview('upload'), /missing from ARM64/i);
  assert.deepEqual(readSet(f.steamSaves), steam); assert.deepEqual(f.state.commands, ['down']); await noRecovery(f);
});

test('explicit pending upload uses ARM64 bytes and backs up differing Steam-local bytes', async t => {
  const f = fixture(t); writeSet(f.steamSaves, saves(['auto',3], 41)); f.writeCache();
  const steam = readSet(f.steamSaves), native = readSet(f.native), preview = await f.api.preview('upload');
  assert.ok(preview.changedCount > 0); const result = await f.api.sync(preview.token);
  assert.deepEqual(f.state.remote, native); assert.deepEqual(readSet(f.native), native);
  const backup = result.backupPaths.find(folder => folder.endsWith('steam-before-upload'));
  assert.deepEqual(readSet(path.join(backup, 'files')), steam); await noRecovery(f);
});

test('terminal upload with pending state never produces false success', async t => {
  const f = fixture(t), preview = await f.api.preview('upload'); f.state.up = 'pending';
  await assert.rejects(f.api.sync(preview.token), error => error.quiescent === true && /pending local saves/i.test(error.message));
  assert.deepEqual(f.state.commands, ['down','down','up']); await noRecovery(f);
});

for (const mode of ['timeout', 'overlap', 'conflict']) test(`unresolved ${mode} still blocks uploads and retains recovery protection`, async t => {
  const f = fixture(t), native = readSet(f.native); f.state.down = mode;
  await assert.rejects(f.api.preview('upload'));
  assert.deepEqual(f.state.commands, ['down']); assert.deepEqual(readSet(f.native), native);
  assert.equal((await f.api.status()).recoveryRequired, true);
  await assert.rejects(f.api.preview('upload'), /uncertain result/i);
});
