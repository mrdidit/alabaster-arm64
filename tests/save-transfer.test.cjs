'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createSaveTransfer, parseGameSave, prepareSlotSelection} = require('../src/save-transfer.cjs');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alabaster-save-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const roots = {steam: path.join(root, 'Steam saves'), arm64: path.join(root, 'ARM64 saves')};
  await fs.mkdir(roots.steam);
  await fs.mkdir(roots.arm64);
  const files = options.files || ['save\\slot1.json', 'slot2.json'];
  const backupRoot = path.join(root, 'backups');
  const api = createSaveTransfer({roots, backupRoot, files, isBusy: options.isBusy || (async () => false),
    validateFile: options.validateFile || ((name, bytes) => JSON.parse(bytes.toString('utf8'))),
    prepareSelection: options.prepareSelection, inventoryFingerprint: options.inventoryFingerprint,
    allowSubdirectories: options.allowSubdirectories, validatePair: options.validatePair, planTransaction: options.planTransaction});
  const put = async (key, name, value) => {
    await fs.mkdir(path.dirname(path.join(roots[key], name)), {recursive: true});
    return fs.writeFile(path.join(roots[key], name), JSON.stringify(value));
  };
  const get = async (key, name) => JSON.parse(await fs.readFile(path.join(roots[key], name), 'utf8'));
  return {root, roots, files, backupRoot, api, put, get};
}

test('copies literal backslash names, preserves unmatched destination and saves exact backup', async t => {
  const f = await fixture(t);
  await f.put('steam', f.files[0], {progress: 10});
  await f.put('arm64', f.files[0], {progress: 4});
  await f.put('arm64', f.files[1], {progress: 8});
  const before = await fs.readFile(path.join(f.roots.arm64, f.files[0]));
  const state = await f.api.status();
  assert.equal(state.steam.count, 1);
  assert.equal(state.arm64.count, 2);
  assert.equal(state.busy, false);
  assert.equal(state.steam.latest, null); // Arbitrary file IDs are not current game saves.
  const preview = await f.api.preview('steam-to-arm64');
  assert.equal(preview.overwriteCount, 1);
  assert.equal(preview.destinationLabel, 'ARM64 version');
  assert.deepEqual(await f.get('arm64', f.files[0]), {progress: 4});
  const result = await f.api.sync('steam-to-arm64');
  assert.equal(result.copied, 1);
  assert.deepEqual(await f.get('arm64', f.files[0]), {progress: 10});
  assert.deepEqual(await f.get('arm64', f.files[1]), {progress: 8});
  assert.deepEqual(await fs.readFile(path.join(result.backup, 'originals', f.files[0])), before);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.backup, 'manifest.json'))).state, 'complete');
});

test('reverse direction copies only saves present at source', async t => {
  const f = await fixture(t);
  await f.put('arm64', f.files[1], {progress: 11});
  await f.api.preview('arm64-to-steam');
  assert.equal((await f.api.sync('arm64-to-steam')).copied, 1);
  assert.deepEqual(await f.get('steam', f.files[1]), {progress: 11});
});

test('requires a preview for the exact direction and invalidates it after use', async t => {
  const f = await fixture(t);
  await f.put('steam', f.files[0], {progress: 1});
  await assert.rejects(f.api.sync('steam-to-arm64'), /Preview and confirm/);
  await f.api.preview('steam-to-arm64');
  await assert.rejects(f.api.sync('arm64-to-steam'), /Preview and confirm/);
  await assert.rejects(f.api.sync('steam-to-arm64'), /Preview and confirm/);
  await assert.rejects(f.api.preview('__proto__'), /Unknown/);
});

test('rejects changes at source or destination after preview', async t => {
  const f = await fixture(t);
  await f.put('steam', f.files[0], {progress: 1});
  await f.put('arm64', f.files[0], {progress: 0});
  await f.api.preview('steam-to-arm64');
  await f.put('steam', f.files[0], {progress: 2});
  await assert.rejects(f.api.sync('steam-to-arm64'), /changed after the preview/);
  await f.api.preview('steam-to-arm64');
  await f.put('arm64', f.files[0], {progress: 3});
  await assert.rejects(f.api.sync('steam-to-arm64'), /changed after the preview/);
  assert.deepEqual(await f.get('arm64', f.files[0]), {progress: 3});
});

test('running-game check is repeated before copying', async t => {
  let busy = false;
  const f = await fixture(t, {isBusy: async () => busy});
  await f.put('steam', f.files[0], {progress: 1});
  await f.api.preview('steam-to-arm64');
  busy = true;
  await assert.rejects(f.api.sync('steam-to-arm64'), /Close both versions/);
  assert.equal((await f.api.status()).busy, true);
  await assert.rejects(f.api.preview('steam-to-arm64'), /Close both versions/);
});

test('rejects malformed source data without replacing valid destination', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.roots.steam, f.files[0]), 'not json');
  await f.put('arm64', f.files[0], {progress: 7});
  await assert.rejects(f.api.preview('steam-to-arm64'), SyntaxError);
  assert.deepEqual(await f.get('arm64', f.files[0]), {progress: 7});
});

test('empty source cannot erase destination saves; identical data is a no-op', async t => {
  const f = await fixture(t);
  await f.put('arm64', f.files[0], {progress: 7});
  await assert.rejects(f.api.preview('steam-to-arm64'), /No local saves/);
  await f.put('steam', f.files[0], {progress: 7});
  await f.api.preview('steam-to-arm64');
  assert.deepEqual(await f.api.sync('steam-to-arm64'), {copied: 0, backup: null});
  await assert.rejects(fs.stat(f.backupRoot), {code: 'ENOENT'});
});

test('rejects a save symlink and a directory masquerading as a file', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'outside.json');
  await fs.writeFile(target, '{}');
  await fs.symlink(target, path.join(f.roots.steam, f.files[0]));
  await assert.rejects(f.api.preview('steam-to-arm64'), /Cannot read save/);
  await fs.unlink(path.join(f.roots.steam, f.files[0]));
  await fs.mkdir(path.join(f.roots.steam, f.files[0]));
  await assert.rejects(f.api.preview('steam-to-arm64'), /regular file/);
});

test('rejects symlinked parent directories', async t => {
  const f = await fixture(t);
  const actual = path.join(f.root, 'actual saves');
  await fs.rename(f.roots.steam, actual);
  await fs.symlink(actual, f.roots.steam);
  await assert.rejects(f.api.status(), /regular directory/);
});

test('rejects oversized files before reading their contents', async t => {
  const f = await fixture(t);
  const handle = await fs.open(path.join(f.roots.steam, f.files[0]), 'w');
  await handle.truncate(64 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(f.api.preview('steam-to-arm64'), /supported transfer size/);
});

test('creates a missing destination directory after a confirmed preview', async t => {
  const f = await fixture(t);
  await fs.rmdir(f.roots.arm64);
  await f.put('steam', f.files[0], {progress: 9});
  await f.api.preview('steam-to-arm64');
  assert.equal((await f.api.sync('steam-to-arm64')).copied, 1);
  assert.deepEqual(await f.get('arm64', f.files[0]), {progress: 9});
});

test('a partial replacement failure restores earlier files from the captured destination', async t => {
  const f = await fixture(t);
  for (const name of f.files) {
    await f.put('steam', name, {progress: 10});
    await f.put('arm64', name, {progress: 2});
  }
  await f.api.preview('steam-to-arm64');
  const original = fs.rename;
  let failed = false;
  fs.rename = async (from, to) => {
    if (!failed && to === path.join(f.roots.arm64, f.files[1])) {
      failed = true;
      throw Object.assign(new Error('simulated write failure'), {code: 'EIO'});
    }
    return original(from, to);
  };
  try { await assert.rejects(f.api.sync('steam-to-arm64'), /simulated write failure/); }
  finally { fs.rename = original; }
  for (const name of f.files) assert.deepEqual(await f.get('arm64', name), {progress: 2});
  const backups = await fs.readdir(f.backupRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(f.backupRoot, backups[0], 'manifest.json')));
  assert.equal(manifest.state, 'failed-restored');
});

test('validates fixed basenames and requires explicit validation and idle callbacks', () => {
  const opts = {roots: {steam: '/tmp/steam', arm64: '/tmp/arm64'}, backupRoot: '/tmp/backups',
    files: ['save.json'], isBusy: async () => false, validateFile: () => {}};
  for (const name of ['../save.json', 'dir/save.json', '.', '..', '', 'bad\0name'])
    assert.throws(() => createSaveTransfer({...opts, files: [name]}), /basenames/);
  assert.throws(() => createSaveTransfer({...opts, validateFile: undefined}), /required/);
  assert.throws(() => createSaveTransfer({...opts, roots: {steam: '/tmp/same', arm64: '/tmp/same'}}), /separate/);
});

test('backs up malformed destination data before repairing it', async t => {
  const f = await fixture(t);
  await f.put('steam', f.files[0], {progress: 13});
  await fs.writeFile(path.join(f.roots.arm64, f.files[0]), 'broken save bytes');
  await f.api.preview('steam-to-arm64');
  const result = await f.api.sync('steam-to-arm64');
  assert.equal(await fs.readFile(path.join(result.backup, 'originals', f.files[0]), 'utf8'), 'broken save bytes');
  assert.deepEqual(await f.get('arm64', f.files[0]), {progress: 13});
});

test('a symlinked backup root is rejected before any destination replacement', async t => {
  const f = await fixture(t);
  await f.put('steam', f.files[0], {progress: 13});
  await f.put('arm64', f.files[0], {progress: 2});
  const elsewhere = path.join(f.root, 'elsewhere');
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, f.backupRoot);
  await f.api.preview('steam-to-arm64');
  await assert.rejects(f.api.sync('steam-to-arm64'), /regular directory/);
  assert.deepEqual(await f.get('arm64', f.files[0]), {progress: 2});
});

test('a backup preparation change is rejected before replacements begin', async t => {
  let checks = 0;
  let f;
  f = await fixture(t, {isBusy: async () => {
    if (++checks === 3) await f.put('steam', f.files[0], {progress: 14});
    return false;
  }});
  await f.put('steam', f.files[0], {progress: 13});
  await f.put('arm64', f.files[0], {progress: 2});
  await f.api.preview('steam-to-arm64');
  await assert.rejects(f.api.sync('steam-to-arm64'), /changed while preparing/);
  assert.deepEqual(await f.get('arm64', f.files[0]), {progress: 2});
});

test('maps version-specific literal basenames and writes System.save last', async t => {
  const files = ['Slot1.save', 'System.save'].map(id => ({id,
    steam: `Alabaster Dawn\\Saves\\Default\\${id}`, arm64: `profile\\Saves\\Default\\${id}`}));
  const validated = [];
  const f = await fixture(t, {files, validateFile: (id, buffer) => {
    validated.push(id); JSON.parse(buffer.toString('utf8'));
  }});
  for (const names of files) {
    await f.put('steam', names.steam, {progress: 8});
    await f.put('arm64', names.arm64, {progress: 1});
  }
  await f.api.preview('steam-to-arm64');
  const result = await f.api.sync('steam-to-arm64');
  const manifest = JSON.parse(await fs.readFile(path.join(result.backup, 'manifest.json')));
  assert.deepEqual(manifest.files.map(file => file.name), ['Slot1.save', 'System.save']);
  assert.deepEqual(validated, ['Slot1.save', 'System.save', 'Slot1.save', 'System.save']);
  for (const names of files) {
    assert.deepEqual(await f.get('arm64', names.arm64), {progress: 8});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.backup, 'originals', names.arm64))), {progress: 1});
    assert.equal(manifest.files.find(file => file.name === names.id).sourceName, names.steam);
  }
  await f.put('arm64', files[0].arm64, {progress: 9});
  await f.api.preview('arm64-to-steam');
  await f.api.sync('arm64-to-steam');
  assert.deepEqual(await f.get('steam', files[0].steam), {progress: 9});
});

test('mapped filename rollback restores the correct version-specific target', async t => {
  const files = ['Slot1.save', 'System.save'].map(id => ({id,
    steam: `Alabaster Dawn\\Saves\\Default\\${id}`, arm64: `profile\\Saves\\Default\\${id}`}));
  const f = await fixture(t, {files});
  for (const names of files) {
    await f.put('steam', names.steam, {progress: 10});
    await f.put('arm64', names.arm64, {progress: 2});
  }
  await f.api.preview('steam-to-arm64');
  const original = fs.rename;
  let failed = false;
  fs.rename = async (from, to) => {
    if (!failed && to === path.join(f.roots.arm64, files[1].arm64)) {
      failed = true;
      throw Object.assign(new Error('simulated mapped-file failure'), {code: 'EIO'});
    }
    return original(from, to);
  };
  try { await assert.rejects(f.api.sync('steam-to-arm64'), /mapped-file failure/); }
  finally { fs.rename = original; }
  for (const names of files) assert.deepEqual(await f.get('arm64', names.arm64), {progress: 2});
});

const slotFiles = ['Default', 'Backups', 'Backups2'].flatMap(generation =>
  ['Save_ID_0001.save', 'Save_ID_0002.save', 'Save_ID_0010.save', 'Save_ID_auto.save', 'System.save']
    .map(name => ({id: `${generation}:${name}`, steam: `${generation}/${name}`, arm64: `${generation}/${name}`})));
const slotData = n => ({vars: {progress: n}, sub: {player: {hp: n}}, meta: {player: {level: n}}});
const indexData = entries => ({lastUsedID: 2, lastUsedManualID: 2, autoSaveLastManualID: 2,
  sub: {settings: {volume: 0.6}, controls: {custom: true}},
  meta: Object.fromEntries(entries.map(n => [String(n), {id: n, time: n, sub: slotData(n).meta}]))});
async function slotFixture(t, extra = {}) {
  return fixture(t, {files: slotFiles, allowSubdirectories: true, validateFile: parseGameSave,
    prepareSelection: prepareSlotSelection, ...extra});
}

test('individual slot merges only its current file and metadata, retaining settings and backup generations', async t => {
  const f = await slotFixture(t);
  await f.put('steam', 'Default/Save_ID_0001.save', slotData(20));
  await f.put('steam', 'Default/System.save', {...indexData([1]), sub: {settings: {volume: 0.1}}});
  const destination = indexData([1, 2]);
  await f.put('arm64', 'Default/System.save', destination);
  await f.put('arm64', 'Default/Save_ID_0001.save', slotData(1));
  await f.put('arm64', 'Default/Save_ID_0002.save', slotData(2));
  await f.put('arm64', 'Default/Save_ID_auto.save', slotData(3));
  await f.put('arm64', 'Backups/Save_ID_0001.save', slotData(4));
  const preview = await f.api.preview('steam-to-arm64', 1);
  assert.equal(preview.selectionLabel, 'Slot 1'); assert.equal(preview.overwriteCount, 2);
  const result = await f.api.sync('steam-to-arm64', 1);
  assert.equal(result.copied, 2);
  assert.deepEqual(await f.get('arm64', 'Default/Save_ID_0001.save'), slotData(20));
  assert.deepEqual(await f.get('arm64', 'Default/Save_ID_0002.save'), slotData(2));
  assert.deepEqual(await f.get('arm64', 'Default/Save_ID_auto.save'), slotData(3));
  assert.deepEqual(await f.get('arm64', 'Backups/Save_ID_0001.save'), slotData(4));
  const merged = await f.get('arm64', 'Default/System.save');
  assert.deepEqual(merged.sub, destination.sub);
  assert.deepEqual(merged.meta['2'], destination.meta['2']);
  for (const key of ['lastUsedID', 'lastUsedManualID', 'autoSaveLastManualID']) assert.equal(merged[key], destination[key]);
  assert.deepEqual(merged.meta['1'].sub, slotData(20).meta);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.backup, 'originals/Default/System.save'))), destination);
  await f.api.preview('steam-to-arm64', 1);
  assert.deepEqual(await f.api.sync('steam-to-arm64', 1), {copied: 0, backup: null});
});

test('slot ten is selected by numeric ID rather than order; an empty destination gets only its index', async t => {
  const f = await slotFixture(t);
  await f.put('steam', 'Default/Save_ID_0001.save', slotData(1));
  await f.put('steam', 'Default/Save_ID_0010.save', slotData(10));
  await f.put('steam', 'Default/System.save', indexData([10, 1]));
  await f.api.preview('steam-to-arm64', 10); await f.api.sync('steam-to-arm64', 10);
  assert.deepEqual(await f.get('arm64', 'Default/Save_ID_0010.save'), slotData(10));
  assert.deepEqual(Object.keys((await f.get('arm64', 'Default/System.save')).meta), ['10']);
  assert.deepEqual((await f.get('arm64', 'Default/System.save')).sub, {});
  await assert.rejects(fs.stat(path.join(f.roots.arm64, 'Default/Save_ID_0001.save')), {code: 'ENOENT'});
});

test('slot selection must match approval and rejects empty, backup-only or unindexed current slots', async t => {
  const f = await slotFixture(t);
  await f.put('steam', 'Backups/Save_ID_0001.save', slotData(1));
  await f.put('steam', 'Default/System.save', indexData([1]));
  await assert.rejects(f.api.preview('steam-to-arm64', 1), /no current source save/);
  await f.put('steam', 'Default/Save_ID_0001.save', slotData(1));
  await f.api.preview('steam-to-arm64', 1);
  await assert.rejects(f.api.sync('steam-to-arm64', 'all'), /selection first/);
  for (const selection of [0, 11, '1', null, {}, 1.5]) await assert.rejects(f.api.preview('steam-to-arm64', selection), /Choose All/);
  await f.put('steam', 'Default/System.save', indexData([]));
  await assert.rejects(f.api.preview('steam-to-arm64', 1), /not indexed/);
});

test('partial copy refuses damaged destination metadata and rechecks unrelated changes', async t => {
  const f = await slotFixture(t);
  await f.put('steam', 'Default/Save_ID_0001.save', slotData(1));
  await f.put('steam', 'Default/System.save', indexData([1]));
  await f.put('arm64', 'Default/Save_ID_0002.save', slotData(2));
  await assert.rejects(f.api.preview('steam-to-arm64', 1), /System.save is missing/);
  await f.put('arm64', 'Default/System.save', indexData([2]));
  await f.api.preview('steam-to-arm64', 1);
  await f.put('arm64', 'Default/Save_ID_0002.save', slotData(3));
  await assert.rejects(f.api.sync('steam-to-arm64', 1), /changed after the preview/);
});

test('new recognized files outside an existing plan invalidate its inventory approval', async t => {
  let inventory = 'before';
  const f = await slotFixture(t, {inventoryFingerprint: () => inventory});
  await f.put('steam', 'Default/Save_ID_0001.save', slotData(1));
  await f.put('steam', 'Default/System.save', indexData([1]));
  await f.api.preview('steam-to-arm64', 1);
  inventory = 'new slot added';
  await assert.rejects(f.api.sync('steam-to-arm64', 1), /changed after the preview/);
});

test('nested full-game paths reject traversal and linked generation folders', async t => {
  const opts = {roots: {steam: '/tmp/a', arm64: '/tmp/b'}, backupRoot: '/tmp/c',
    allowSubdirectories: true, isBusy: async () => false, validateFile: () => {}};
  for (const name of ['/absolute.save', '../file.save', 'Default/../file.save', 'Default//file.save', './file.save'])
    assert.throws(() => createSaveTransfer({...opts, files: [{id: 'slot', steam: name, arm64: name}]}), /filenames/);
  const f = await slotFixture(t);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.roots.steam, 'Default'));
  await assert.rejects(f.api.status(), /regular directory/);
});

test('failed nested System replacement restores selected slot and retains destination index', async t => {
  const f = await slotFixture(t);
  for (const side of ['steam', 'arm64']) {
    await f.put(side, 'Default/Save_ID_0001.save', slotData(side === 'steam' ? 9 : 1));
    await f.put(side, 'Default/System.save', indexData([1]));
  }
  await f.api.preview('steam-to-arm64', 1);
  const rename = fs.rename; let injected = false;
  fs.rename = async (from, to) => {
    if (!injected && to === path.join(f.roots.arm64, 'Default/System.save')) {injected = true; throw new Error('nested failure');}
    return rename(from, to);
  };
  try {await assert.rejects(f.api.sync('steam-to-arm64', 1), /nested failure/);} finally {fs.rename = rename;}
  assert.deepEqual(await f.get('arm64', 'Default/Save_ID_0001.save'), slotData(1));
  assert.deepEqual(await f.get('arm64', 'Default/System.save'), indexData([1]));
});

const trigger = 'Auxiliary:legacy-System.save';
const triggerName = 'Default\\Saves\\Default\\System.save';
async function retirementFixture(t) {
  const files = [{id: 'Default:Save_ID_auto.save', steam: 'Saves/Default/Save_ID_auto.save', arm64: 'Saves/Default/Save_ID_auto.save'},
    {id: 'Default:System.save', steam: 'Saves/Default/System.save', arm64: 'Saves/Default/System.save'},
    {id: trigger, steam: triggerName, arm64: triggerName, auxiliary: true, removable: true}];
  const f = await fixture(t, {files, allowSubdirectories: true, validateFile: parseGameSave,
    planTransaction: ({destination}) => destination[trigger] ? {remove: [trigger], note: 'Old index is backed up and removed last.'} : {}});
  await f.put('arm64', 'Saves/Default/Save_ID_auto.save', slotData(7));
  await f.put('arm64', 'Saves/Default/System.save', indexData([1]));
  await f.put('steam', triggerName, indexData([2]));
  return f;
}

test('auxiliary retirement is previewed, exactly backed up, and performed after normal replacements', async t => {
  const f = await retirementFixture(t);
  const original = await fs.readFile(path.join(f.roots.steam, triggerName));
  const status = await f.api.status({independent: true});
  assert.equal(status.steam.count, 0); assert.equal(status.arm64.count, 2);
  const preview = await f.api.preview('arm64-to-steam');
  assert.equal(preview.retiredCount, 1); assert.equal(preview.sourceCount, 2); assert.match(preview.preservationNote, /backed up/);
  const unlink = fs.unlink; let sawRetirement = false;
  fs.unlink = async name => {
    if (name === path.join(f.roots.steam, triggerName)) {
      assert.deepEqual(await f.get('steam', 'Saves/Default/Save_ID_auto.save'), slotData(7));
      assert.deepEqual(await f.get('steam', 'Saves/Default/System.save'), indexData([1]));
      sawRetirement = true;
    }
    return unlink(name);
  };
  let result;
  try {result = await f.api.sync('arm64-to-steam');} finally {fs.unlink = unlink;}
  assert.equal(sawRetirement, true); assert.equal(result.copied, 2); assert.equal(result.retired, 1);
  assert.deepEqual(await fs.readFile(path.join(result.backup, 'originals', triggerName)), original);
  await assert.rejects(fs.stat(path.join(f.roots.steam, triggerName)), {code: 'ENOENT'});
  const manifest = JSON.parse(await fs.readFile(path.join(result.backup, 'manifest.json')));
  assert.equal(manifest.files.at(-1).action, 'remove'); assert.equal(manifest.state, 'complete');
  assert.deepEqual(await f.get('arm64', 'Saves/Default/Save_ID_auto.save'), slotData(7));
});

test('changed auxiliary index invalidates approval before normal files are written', async t => {
  const f = await retirementFixture(t);
  await f.api.preview('arm64-to-steam');
  await f.put('steam', triggerName, indexData([10]));
  await assert.rejects(f.api.sync('arm64-to-steam'), /changed after the preview/);
  await assert.rejects(fs.stat(path.join(f.roots.steam, 'Saves/Default/System.save')), {code: 'ENOENT'});
  assert.deepEqual(await f.get('steam', triggerName), indexData([10]));
});

test('failed trigger retirement rolls normal replacements back and retains the original index', async t => {
  const f = await retirementFixture(t);
  await f.api.preview('arm64-to-steam');
  const unlink = fs.unlink;
  fs.unlink = async name => {if(name === path.join(f.roots.steam, triggerName)) throw new Error('retirement failed'); return unlink(name);};
  try {await assert.rejects(f.api.sync('arm64-to-steam'), /retirement failed/);} finally {fs.unlink = unlink;}
  assert.deepEqual(await f.get('steam', triggerName), indexData([2]));
  await assert.rejects(fs.stat(path.join(f.roots.steam, 'Saves/Default/System.save')), {code: 'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.roots.steam, 'Saves/Default/Save_ID_auto.save')), {code: 'ENOENT'});
});

test('failure after retirement restores the retired index and removes new files', async t => {
  const f = await retirementFixture(t);
  await f.api.preview('arm64-to-steam');
  const write = fs.writeFile; let injected = false;
  fs.writeFile = async (name, content, ...args) => {
    if (!injected && String(name).endsWith('/manifest.json') && JSON.parse(content).state === 'complete') {
      injected = true; throw new Error('completion record failed');
    }
    return write(name, content, ...args);
  };
  try {await assert.rejects(f.api.sync('arm64-to-steam'), /completion record failed/);} finally {fs.writeFile = write;}
  assert.equal(injected, true); assert.deepEqual(await f.get('steam', triggerName), indexData([2]));
  await assert.rejects(fs.stat(path.join(f.roots.steam, 'Saves/Default/System.save')), {code: 'ENOENT'});
  const backups = await fs.readdir(f.backupRoot);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.backupRoot, backups[0], 'manifest.json'))).state, 'failed-restored');
});

test('only explicitly removable auxiliary files can be retired', async t => {
  const f = await fixture(t, {planTransaction: () => ({remove: ['slot2.json']})});
  await f.put('steam', f.files[0], {progress: 1}); await f.put('arm64', 'slot2.json', {progress: 2});
  await assert.rejects(f.api.preview('steam-to-arm64'), /additional save operation/);
  assert.deepEqual(await f.get('arm64', 'slot2.json'), {progress: 2});
});

test('independent status retains valid source counts when the other profile cannot be read', async t => {
  const f = await retirementFixture(t);
  const outside = path.join(f.root, 'outside.save'); await fs.writeFile(outside, '{}');
  await fs.unlink(path.join(f.roots.steam, triggerName)); await fs.symlink(outside, path.join(f.roots.steam, triggerName));
  const status = await f.api.status({independent: true});
  assert.equal(status.arm64.count, 2); assert.equal(status.steam.count, null); assert.match(status.steam.error, /Cannot read save/);
});

test('multi selection merges all selected entries once and preserves unselected progress/settings/autosave/backups', async t => {
  const f = await slotFixture(t);
  for (const [id, progress] of [[1, 21], [2, 22]]) await f.put('steam', `Default/Save_ID_${String(id).padStart(4, '0')}.save`, slotData(progress));
  await f.put('steam', 'Default/System.save', indexData([1, 2]));
  for (const id of [1, 2, 10]) await f.put('arm64', `Default/Save_ID_${String(id).padStart(4, '0')}.save`, slotData(id));
  const original = indexData([1, 2, 10]);
  await f.put('arm64', 'Default/System.save', original);
  await f.put('arm64', 'Default/Save_ID_auto.save', slotData(3));
  await f.put('arm64', 'Backups/Save_ID_0002.save', slotData(4));
  const preview = await f.api.preview('steam-to-arm64', [2, 1, 2]);
  assert.deepEqual(preview.selection, [1, 2]); assert.equal(preview.selectionLabel, 'Slots 1, 2');
  assert.equal(preview.sourceCount, 3); assert.deepEqual(preview.entries.map(entry => entry.id), [1, 2]);
  assert.ok(preview.entries.every(entry => entry.changed && Date.parse(entry.sourceModified) && Date.parse(entry.destinationModified)));
  const result = await f.api.sync('steam-to-arm64', [1, 2]);
  assert.equal(result.copied, 3);
  const merged = await f.get('arm64', 'Default/System.save');
  assert.deepEqual(merged.meta['1'].sub, slotData(21).meta); assert.deepEqual(merged.meta['2'].sub, slotData(22).meta);
  assert.deepEqual(merged.meta['10'], original.meta['10']); assert.deepEqual(merged.sub, original.sub);
  for (const key of ['lastUsedID', 'lastUsedManualID', 'autoSaveLastManualID']) assert.equal(merged[key], original[key]);
  assert.deepEqual(await f.get('arm64', 'Default/Save_ID_auto.save'), slotData(3));
  assert.deepEqual(await f.get('arm64', 'Default/Save_ID_0010.save'), slotData(10));
  assert.deepEqual(await f.get('arm64', 'Backups/Save_ID_0002.save'), slotData(4));
  await f.api.preview('steam-to-arm64', [2, 1]);
  assert.deepEqual(await f.api.sync('steam-to-arm64', [1, 2, 1]), {copied: 0, backup: null});
});

test('preview owns its canonical selection and confirmation compares values rather than array identity', async t => {
  const f = await slotFixture(t);
  await f.put('steam', 'Default/Save_ID_0001.save', slotData(1));
  await f.put('steam', 'Default/Save_ID_0002.save', slotData(2));
  await f.put('steam', 'Default/System.save', indexData([1, 2]));
  const selected = [1, 2], pending = f.api.preview('steam-to-arm64', selected);
  selected.splice(0, 2, 10);
  const preview = await pending;
  assert.deepEqual(preview.selection, [1, 2]); assert.equal(Object.isFrozen(preview.selection), true);
  await assert.rejects(f.api.sync('steam-to-arm64', selected), /selection first/);
  await assert.rejects(f.api.sync('steam-to-arm64', [1, 2]), /selection first/);
  await f.api.preview('steam-to-arm64', [1]);
  assert.equal((await f.api.sync('steam-to-arm64', 1)).copied, 2);
  await f.api.preview('steam-to-arm64', 2);
  assert.equal((await f.api.sync('steam-to-arm64', [2])).copied, 2);
});

test('multi selection rejects empty, sparse, out-of-range and mixed-type arrays before writes', async t => {
  const f = await slotFixture(t);
  await f.put('steam', 'Default/Save_ID_0001.save', slotData(1));
  await f.put('steam', 'Default/System.save', indexData([1]));
  for (const selected of [[], [1, 11], [0], [1, '2'], [1, null], [1, NaN], new Array(2), [,'1'], [[1]], ['all']])
    await assert.rejects(f.api.preview('steam-to-arm64', selected), /Choose All/);
  await assert.rejects(fs.stat(f.backupRoot), {code: 'ENOENT'});
  assert.deepEqual(await fs.readdir(f.roots.arm64), []);
});

test('one missing or unindexed selected slot rejects the complete multi plan without writes', async t => {
  const f = await slotFixture(t);
  await f.put('steam', 'Default/Save_ID_0001.save', slotData(1));
  await f.put('steam', 'Default/System.save', indexData([1]));
  await assert.rejects(f.api.preview('steam-to-arm64', [1, 2]), /Slot 2 has no current/);
  await f.put('steam', 'Default/Save_ID_0002.save', slotData(2));
  await assert.rejects(f.api.preview('steam-to-arm64', [1, 2]), /Slot 2 is not indexed/);
  await assert.rejects(fs.stat(f.backupRoot), {code: 'ENOENT'});
  assert.deepEqual(await fs.readdir(f.roots.arm64), []);
});

test('failure publishing merged multi index restores both selected files and unchanged destination metadata', async t => {
  const f = await slotFixture(t);
  for (const side of ['steam', 'arm64']) {
    for (const id of [1, 2]) await f.put(side, `Default/Save_ID_${String(id).padStart(4, '0')}.save`, slotData(id + (side === 'steam' ? 10 : 0)));
    await f.put(side, 'Default/System.save', indexData([1, 2]));
  }
  await f.api.preview('steam-to-arm64', [1, 2]);
  const rename = fs.rename; let injected = false;
  fs.rename = async (from, to) => {
    if (!injected && to === path.join(f.roots.arm64, 'Default/System.save')) {
      assert.deepEqual(await f.get('arm64', 'Default/Save_ID_0001.save'), slotData(11));
      assert.deepEqual(await f.get('arm64', 'Default/Save_ID_0002.save'), slotData(12));
      injected = true; throw new Error('multi index publication failed');
    }
    return rename(from, to);
  };
  try {await assert.rejects(f.api.sync('steam-to-arm64', [2, 1]), /multi index publication failed/);} finally {fs.rename = rename;}
  for (const id of [1, 2]) assert.deepEqual(await f.get('arm64', `Default/Save_ID_${String(id).padStart(4, '0')}.save`), slotData(id));
  assert.deepEqual(await f.get('arm64', 'Default/System.save'), indexData([1, 2]));
});

test('slot metadata and All latest use current file modification times, never System index or backup dates', async t => {
  const f = await slotFixture(t);
  await f.put('steam', 'Default/Save_ID_0001.save', slotData(1));
  await f.put('steam', 'Default/Save_ID_auto.save', slotData(3));
  await f.put('steam', 'Default/System.save', {...indexData([1, 'auto']), meta: {
    '1': {id: 1, time: 9999999999999, sub: slotData(1).meta}, auto: {id: 'auto', time: 9999999999999, sub: slotData(3).meta}}});
  await f.put('steam', 'Backups/Save_ID_0002.save', slotData(2));
  await f.put('steam', 'Default/Save_ID_0010.save', slotData(10)); // deliberately unindexed
  const times = {'Default/Save_ID_0001.save':'2025-01-01T10:00:00Z', 'Default/Save_ID_auto.save':'2025-02-01T10:00:00Z',
    'Default/System.save':'2026-04-01T10:00:00Z', 'Backups/Save_ID_0002.save':'2026-05-01T10:00:00Z', 'Default/Save_ID_0010.save':'2025-01-02T10:00:00Z'};
  for (const [name, time] of Object.entries(times)) await fs.utimes(path.join(f.roots.steam, name), new Date(time), new Date(time));
  const state = await f.api.status();
  assert.equal(state.steam.count, 5); assert.equal(state.steam.currentCount, 3);
  assert.equal(state.steam.latest, '2025-02-01T10:00:00.000Z');
  assert.deepEqual(state.steam.slots[0], {id: 1, available: true, modified: '2025-01-01T10:00:00.000Z'});
  assert.equal(state.steam.slots[1].available, false); assert.equal(state.steam.slots[1].modified, null); assert.match(state.steam.slots[1].reason, /Backup only/);
  assert.equal(state.steam.slots[2].reason, 'Empty'); assert.match(state.steam.slots[9].reason, /not indexed/);
  assert.deepEqual(state.steam.autosave, {available: true, modified: '2025-02-01T10:00:00.000Z'});
  const preview = await f.api.preview('steam-to-arm64', 'all');
  assert.deepEqual(preview.entries.map(entry => entry.id), ['auto', 1, 10]);
  assert.ok(preview.entries.every(entry => entry.destinationModified === null && entry.changed));
  assert.equal(JSON.stringify(state).includes('buffer'), false); assert.equal(JSON.stringify(preview).includes('buffer'), false);
});

test('All preview retains unchanged current entries but omits System and backup generations', async t => {
  const f = await slotFixture(t);
  for (const side of ['steam','arm64']) {
    await f.put(side, 'Default/Save_ID_0001.save', slotData(1));
    await f.put(side, 'Default/System.save', indexData([1]));
    await f.put(side, 'Backups/Save_ID_0002.save', slotData(2));
  }
  const preview = await f.api.preview('steam-to-arm64');
  assert.equal(preview.sourceCount, 3); assert.equal(preview.entries.length, 1);
  assert.equal(preview.entries[0].id, 1); assert.equal(preview.entries[0].changed, false);
});

test('Auto-only copy retains its source manual association without copying manual slots or changing last-used choices', async t => {
  const f = await slotFixture(t);
  const source = {...indexData(['auto', 1]), autoSaveLastManualID: 1};
  const destination = {...indexData(['auto', 2]), autoSaveLastManualID: 2, lastUsedID: 2, lastUsedManualID: 2};
  await f.put('steam','Default/Save_ID_auto.save',slotData(21));await f.put('steam','Default/Save_ID_0001.save',slotData(1));
  await f.put('steam','Default/System.save',source);
  await f.put('arm64','Default/Save_ID_auto.save',slotData(3));await f.put('arm64','Default/Save_ID_0002.save',slotData(2));
  await f.put('arm64','Default/System.save',destination);await f.put('arm64','Backups/Save_ID_auto.save',slotData(4));
  const preview = await f.api.preview('steam-to-arm64','auto');
  assert.deepEqual(preview.selection,['auto']);assert.equal(preview.selectionLabel,'Auto');assert.deepEqual(preview.entries.map(entry=>entry.id),['auto']);
  assert.equal((await f.api.sync('steam-to-arm64',['auto'])).copied,2);
  const merged=await f.get('arm64','Default/System.save');
  assert.equal(merged.autoSaveLastManualID,1);assert.equal(merged.lastUsedID,2);assert.equal(merged.lastUsedManualID,2);
  assert.deepEqual(merged.sub,destination.sub);assert.deepEqual(merged.meta['2'],destination.meta['2']);assert.deepEqual(merged.meta.auto.sub,slotData(21).meta);
  assert.deepEqual(await f.get('arm64','Default/Save_ID_0002.save'),slotData(2));assert.deepEqual(await f.get('arm64','Backups/Save_ID_auto.save'),slotData(4));
  await assert.rejects(fs.stat(path.join(f.roots.arm64,'Default/Save_ID_0001.save')),{code:'ENOENT'});
  await f.api.preview('steam-to-arm64',['auto']);assert.deepEqual(await f.api.sync('steam-to-arm64','auto'),{copied:0,backup:null});
});

test('Auto source without association removes only destination Auto association, retaining source fallback behavior', async t => {
  const f=await slotFixture(t);
  const source=indexData(['auto']);delete source.autoSaveLastManualID;
  const destination={...indexData(['auto',2]),lastUsedID:2,lastUsedManualID:2,autoSaveLastManualID:2};
  await f.put('steam','Default/Save_ID_auto.save',slotData(5));await f.put('steam','Default/System.save',source);
  await f.put('arm64','Default/Save_ID_auto.save',slotData(5));await f.put('arm64','Default/System.save',destination);
  await f.api.preview('steam-to-arm64','auto');await f.api.sync('steam-to-arm64',['auto']);
  const result=await f.get('arm64','Default/System.save');
  assert.equal(Object.hasOwn(result,'autoSaveLastManualID'),false);assert.equal(result.lastUsedID,2);assert.equal(result.lastUsedManualID,2);
  assert.deepEqual(result.meta['2'],destination.meta['2']);assert.deepEqual(result.sub,destination.sub);
});

test('Auto plus manual selection canonicalizes auto first, merges both entries and rolls all writes back on index failure', async t => {
  const f=await slotFixture(t);
  for(const side of ['steam','arm64']){
    await f.put(side,'Default/Save_ID_auto.save',slotData(side==='steam'?21:3));
    await f.put(side,'Default/Save_ID_0001.save',slotData(side==='steam'?11:1));
    await f.put(side,'Default/System.save',{...indexData(['auto',1]),autoSaveLastManualID:side==='steam'?1:2});
  }
  const before=await f.get('arm64','Default/System.save');
  const preview=await f.api.preview('steam-to-arm64',[1,'auto',1,'auto']);
  assert.deepEqual(preview.selection,['auto',1]);assert.equal(preview.selectionLabel,'Auto + Slot 1');assert.deepEqual(preview.entries.map(entry=>entry.id),['auto',1]);
  const rename=fs.rename;let failed=false;
  fs.rename=async(from,to)=>{
    if(!failed&&to===path.join(f.roots.arm64,'Default/System.save')){
      assert.deepEqual(await f.get('arm64','Default/Save_ID_auto.save'),slotData(21));assert.deepEqual(await f.get('arm64','Default/Save_ID_0001.save'),slotData(11));
      failed=true;throw new Error('Auto/manual index failure');
    }return rename(from,to);
  };
  try{await assert.rejects(f.api.sync('steam-to-arm64',['auto',1]),/Auto\/manual index failure/);}finally{fs.rename=rename;}
  assert.deepEqual(await f.get('arm64','Default/Save_ID_auto.save'),slotData(3));assert.deepEqual(await f.get('arm64','Default/Save_ID_0001.save'),slotData(1));assert.deepEqual(await f.get('arm64','Default/System.save'),before);
  await f.api.preview('steam-to-arm64',[1,'auto']);assert.equal((await f.api.sync('steam-to-arm64',['auto',1])).copied,3);
  const merged=await f.get('arm64','Default/System.save');assert.deepEqual(merged.meta.auto.sub,slotData(21).meta);assert.deepEqual(merged.meta['1'].sub,slotData(11).meta);assert.equal(merged.autoSaveLastManualID,1);
});

test('missing, backup-only, unindexed or invalid-association Auto cannot be selected or shown available', async t => {
  const f=await slotFixture(t);
  await f.put('steam','Default/Save_ID_0001.save',slotData(1));await f.put('steam','Default/System.save',indexData([1]));
  await assert.rejects(f.api.preview('steam-to-arm64',['auto',1]),/Auto has no current/);
  await f.put('steam','Backups/Save_ID_auto.save',slotData(2));
  assert.match((await f.api.status()).steam.autosave.reason,/Backup only/);
  await f.put('steam','Default/Save_ID_auto.save',slotData(3));
  await assert.rejects(f.api.preview('steam-to-arm64','auto'),/Auto is not indexed/);
  assert.equal((await f.api.status()).steam.autosave.available,false);
  await f.put('steam','Default/System.save',{...indexData(['auto',1]),autoSaveLastManualID:'auto'});
  await assert.rejects(f.api.preview('steam-to-arm64','auto'),/unsupported manual-slot association/);
  assert.equal((await f.api.status()).steam.autosave.available,false);
  await assert.rejects(fs.stat(f.backupRoot),{code:'ENOENT'});
});
