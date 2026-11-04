'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {parseGameSave} = require('./save-transfer.cjs');
const {readSteamMarker} = require('./steam-cloud.cjs');

const APP = 3110760;
const FULL_HASH = 'da41f4969f915076c61d4e3bc80a0e1679344f833ac5ede4f70b2a9217e53547';
const MAX_FILE = 64 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024, MAX_FILES = 768;
const generations = ['Default', 'Backups', 'Backups2'];
const savePath = /^(Default|Backups|Backups2)\/(System|Save_ID_(auto|[0-9]{4,16}))\.save$/;
const hash = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fingerprint = files => JSON.stringify(Object.keys(files).sort().map(name => [name, files[name].size, files[name].sha256]));
const manifest = files => Object.fromEntries(Object.keys(files).sort().map(name => [name,
  {size: files[name].size, sha1: files[name].sha1, sha256: files[name].sha256, modified: new Date(files[name].mtime).toISOString()}]));
const latest = files => {
  const current = Object.entries(files).filter(([name]) => /^Default\/Save_ID_/.test(name)).map(([, file]) => file.mtime);
  return current.length ? new Date(Math.max(...current)).toISOString() : null;
};

async function directory(name, create = false) {
  let current = path.parse(name).root;
  for (const part of name.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fs.mkdir(current, {mode: 0o700}); }
      catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A Cloud save directory is linked or invalid.');
  }
  return true;
}

async function readSave(root, name, budget) {
  const handle = await fs.open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({bigint: true});
    if (!before.isFile()) throw new Error(`Save is not a regular file: ${name}`);
    if (before.size > BigInt(MAX_FILE) || budget.bytes + Number(before.size) > MAX_TOTAL)
      throw new Error('Cloud saves exceed the supported transfer size.');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat({bigint: true});
    if (length !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error('Save files changed during the read. Close the game and preview again.');
    const bytes = buffer.subarray(0, length);
    budget.bytes += length;
    return {buffer: bytes, size: length, sha256: hash(bytes), sha1: hash(bytes, 'sha1'), mtime: Number(before.mtimeNs) / 1e6};
  } finally { await handle.close(); }
}

function validate(files, requireCurrent = false) {
  const parsed = {};
  const validID = id => id === null || id === 'auto' || (Number.isSafeInteger(id) && id >= 0);
  for (const [name, file] of Object.entries(files)) {
    const data = parsed[name] = parseGameSave(name.replace('/', ':'), file.buffer);
    if (name.endsWith('/System.save')) {
      if (!validID(data.lastUsedID) || ['lastUsedManualID', 'autoSaveLastManualID'].some(key =>
          Object.hasOwn(data, key) && !validID(data[key]))) throw new Error('System.save has an unsupported last-used slot.');
      for (const [key, entry] of Object.entries(data.meta))
        if (!plain(entry) || !validID(entry.id) || String(entry.id) !== key || !plain(entry.sub))
          throw new Error('System.save contains an unsupported slot index.');
    }
  }
  if (requireCurrent) {
    const current = Object.keys(files).filter(name => /^Default\/Save_ID_/.test(name));
    if (!current.length || !parsed['Default/System.save'])
      throw new Error('The source needs current saves and System.save. Empty Cloud data cannot replace local saves.');
    for (const name of current) {
      const match = savePath.exec(name), id = match[3] === 'auto' ? 'auto' : Number(match[3]);
      if (!validID(id) || parsed['Default/System.save'].meta[String(id)]?.id !== id)
        throw new Error(`The current source save is not indexed correctly: ${name}`);
    }
  }
}

async function snapshot(root, strict) {
  const files = Object.create(null), unknown = [], budget = {bytes: 0};
  if (!await directory(root)) return {files, unknown};
  const top = (await fs.readdir(root)).sort();
  for (const name of top) {
    const full = path.join(root, name), stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error('A Cloud save path is linked. No files were copied.');
    if (strict && name === 'steam_autocloud.vdf') { readSteamMarker(full); continue; }
    if (!generations.includes(name) || !stat.isDirectory()) { unknown.push(name); continue; }
    const names = (await fs.readdir(full)).sort();
    for (const base of names) {
      const relative = `${name}/${base}`, item = await fs.lstat(path.join(full, base));
      if (item.isSymbolicLink()) throw new Error('A Cloud save path is linked. No files were copied.');
      if (!savePath.test(relative)) { unknown.push(relative); continue; }
      if (Object.keys(files).length >= MAX_FILES) throw new Error('Too many Cloud save files.');
      files[relative] = await readSave(root, relative, budget);
    }
    if (JSON.stringify(names) !== JSON.stringify((await fs.readdir(full)).sort())) throw new Error('Save inventory changed during the read.');
  }
  if (JSON.stringify(top) !== JSON.stringify((await fs.readdir(root)).sort())) throw new Error('Save inventory changed during the read.');
  if (strict && unknown.length) throw new Error('Steam Saves contains unrecognized files. Cloud copying is blocked to avoid uploading unrelated data.');
  validate(files);
  return {files, unknown};
}

async function writeNew(name, bytes) {
  const handle = await fs.open(name, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}
async function flush(name) {
  const handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomic(name, bytes, mtime, stagingDirectory = path.dirname(name), published = () => {}) {
  const parent = path.dirname(name);
  await directory(parent, true);
  await directory(stagingDirectory, true);
  const temporary = path.join(stagingDirectory, `.cloud-copy-${crypto.randomUUID()}.tmp`);
  try {
    await writeNew(temporary, bytes);
    if (mtime !== undefined) await fs.utimes(temporary, new Date(mtime), new Date(mtime));
    await fs.rename(temporary, name);
    published();
    await flush(parent);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function createCloudSync({root, context, isBusy, steam}) {
  if (!path.isAbsolute(root) || typeof context !== 'function' || typeof isBusy !== 'function' ||
      typeof steam?.status !== 'function' || typeof steam?.sync !== 'function') throw new Error('Cloud coordination requires checked local paths and a Steam adapter.');
  root = path.resolve(root);
  const lockPath = path.join(root, '.cloud-sync.lock');
  const recoveryPath = path.join(root, 'cloud-recovery.json');
  const backupRoot = path.join(root, 'cloud-backups');
  let pending = null, busy = false;
  const progress = (callback, message) => { try { callback?.({message}); } catch {} };
  const relay = callback => value => { try { callback?.(value); } catch {} };

  function checkedContext() {
    const value = context();
    if (!value || value.variant !== 'full' || value.bundleSha256 !== FULL_HASH ||
        !path.isAbsolute(value.steamProfile || '') || !path.isAbsolute(value.nativeDataPath || '') ||
        path.basename(value.nativeDataPath) !== 'Default') throw new Error('Cloud copying is available only for the checked full-game version.');
    const paths = {steam: path.join(value.steamProfile, 'Saves'), arm64: path.join(path.dirname(value.nativeDataPath), 'Saves')};
    if (paths.steam === paths.arm64 || Object.values(paths).some(p => p === backupRoot || p.startsWith(backupRoot + path.sep) || backupRoot.startsWith(p + path.sep)) ||
        paths.steam.startsWith(paths.arm64 + path.sep) || paths.arm64.startsWith(paths.steam + path.sep))
      throw new Error('Cloud and native save directories must be separate.');
    return {key: JSON.stringify([value.variant, value.bundleSha256, value.gameDir, value.bundlePath, paths]), paths};
  }
  async function idle() {
    if (await isBusy()) throw new Error('Close both versions of Alabaster Dawn before copying Cloud saves.');
  }
  async function account(expected) {
    const state = await steam.status();
    if (!state?.available) throw new Error(state?.reason || 'Steam Cloud is unavailable.');
    if (Number(state.appId) !== APP || !/^\d+$/.test(String(state.accountId || '')))
      throw new Error('Steam account or game identity could not be checked.');
    const id = String(state.accountId);
    if (expected !== undefined && expected !== id) throw new Error('Steam account changed. Preview again.');
    return {id, state};
  }
  async function locked(callback) {
    if (busy) throw new Error('Another Cloud operation is running.');
    busy = true;
    let handle;
    try {
      await directory(root);
      try { handle = await fs.open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Another Cloud operation or an interrupted operation needs attention. Close the other launcher or review its lock.');
        throw error;
      }
      await handle.writeFile(JSON.stringify({pid: process.pid, started: new Date().toISOString()}));
      await handle.sync();
      if (await fs.lstat(recoveryPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }))
        throw new Error('A previous Cloud operation has an uncertain result. Check Steam and the saved recovery record before retrying.');
      return await callback();
    } finally {
      if (handle) { await handle.close(); await fs.unlink(lockPath); }
      busy = false;
    }
  }
  async function backup(label, files, extra = {}) {
    const destination = path.join(backupRoot, `${Date.now()}-${crypto.randomUUID()}-${label}`);
    await directory(destination, true);
    const directories = new Set([destination, backupRoot, root]);
    for (const [name, file] of Object.entries(files)) {
      const to = path.join(destination, 'files', name);
      await directory(path.dirname(to), true);
      directories.add(path.dirname(to)); directories.add(path.join(destination, 'files'));
      await writeNew(to, file.buffer);
      await fs.utimes(to, new Date(file.mtime), new Date(file.mtime));
      const check = await readSave(path.join(destination, 'files'), name, {bytes: 0});
      if (check.sha256 !== file.sha256) throw new Error('Cloud backup verification failed.');
    }
    await writeNew(path.join(destination, 'manifest.json'), Buffer.from(JSON.stringify({label, files: manifest(files), ...extra}, null, 2) + '\n'));
    // Persist directory entries as well as file contents before any save is
    // replaced or removed. Verify-by-read alone is not crash durability.
    for (const name of [...directories].sort((a, b) => b.length - a.length)) await flush(name);
    return destination;
  }
  async function recover(message, data) {
    await atomic(recoveryPath, Buffer.from(JSON.stringify({message, time: new Date().toISOString(), ...data}, null, 2) + '\n'));
  }
  function verifyRemote(result, expectedAccount, files) {
    if (result?.result !== 'ok')
      throw new Error('Steam did not confirm the expected account and completed Cloud transfer.');
    verifyFiles(result, expectedAccount, files);
  }
  function verifyFiles(result, expectedAccount, files) {
    if (String(result.accountId) !== expectedAccount || !plain(result.files))
      throw new Error('Steam did not confirm the expected account and save inventory.');
    const keys = Object.keys(result.files).sort();
    if (keys.length > MAX_FILES || keys.some(name => !savePath.test(name))) throw new Error('Steam Cloud contains unsupported save paths.');
    if (JSON.stringify(keys) !== JSON.stringify(Object.keys(files).sort())) throw new Error('Steam local files do not match the verified Cloud file list.');
    for (const name of keys) {
      const remote = result.files[name];
      if (!plain(remote) || !/^[a-f0-9]{40}$/i.test(remote.sha1 || '') || !Number.isSafeInteger(remote.size) ||
          remote.size !== files[name].size || remote.sha1.toLowerCase() !== files[name].sha1)
        throw new Error('Steam local bytes do not match the verified Cloud files.');
    }
  }
  async function down(ctx, accountId, onProgress, backups, allowPending = false) {
    const before = await snapshot(ctx.paths.steam, true);
    if (Object.keys(before.files).length) backups.push(await backup('steam-before-download', before.files, {accountId}));
    progress(onProgress, 'Checking Steam Cloud…');
    let result;
    try { result = await steam.sync('down', relay(onProgress)); }
    catch (error) {
      if (!error.quiescent) await recover('Steam download may still be running.', {accountId, backupPaths: backups, error: error.message});
      error.backupPaths = [...backups];
      throw error;
    }
    await account(accountId);
    if (checkedContext().key !== ctx.key) throw new Error('Game setup changed during Cloud synchronization.');
    await idle();
    const after = await snapshot(ctx.paths.steam, true);
    const pendingUpload = result?.result === 'pending-local';
    if (pendingUpload) {
      verifyFiles(result, accountId, after.files);
      if (!/^[a-f0-9]{64}$/.test(result.cacheToken || '') || !Array.isArray(result.cachePaths) ||
          result.cachePaths.some(name => !savePath.test(name) || !after.files[name]) ||
          !Array.isArray(result.pendingFiles) || !result.pendingFiles.length ||
          result.pendingFiles.some(name => !savePath.test(name) || !after.files[name]))
        throw new Error('Pending Steam saves could not be checked. Resolve them in Steam before retrying.');
      if (!allowPending) throw new Error('Local Steam saves are waiting to upload. Use Upload ARM64 saves to upload the ARM64 version, or resolve the local changes in Steam before downloading.');
    } else verifyRemote(result, accountId, after.files);
    return {...after, pendingUpload, cacheToken: result.cacheToken, cachePaths: result.cachePaths || Object.keys(result.files)};
  }
  async function replaceSet(folder, before, desired) {
    const writes = Object.keys(desired).filter(name => before[name]?.sha256 !== desired[name].sha256)
      .sort((a, b) => Number(a.endsWith('/System.save')) - Number(b.endsWith('/System.save')) || a.localeCompare(b));
    const removals = Object.keys(before).filter(name => !desired[name]);
    const touched = [];
    async function current(name) {
      if (!await directory(path.dirname(path.join(folder, name)))) return null;
      try { return await readSave(folder, name, {bytes: 0}); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    async function requireValue(name, expected) {
      const actual = await current(name);
      if (actual?.sha256 !== expected?.sha256) throw new Error(`Save changed during the transfer: ${name}`);
    }
    try {
      for (const name of writes) {
        await requireValue(name, before[name]);
        // Stage outside Saves: Steam's Auto-Cloud rule includes every file
        // below Saves, not only *.save. Temporary files must not enter it.
        await atomic(path.join(folder, name), desired[name].buffer, desired[name].mtime, path.dirname(folder), () => touched.push(name));
      }
      for (const name of removals) {
        await requireValue(name, before[name]);
        await fs.unlink(path.join(folder, name));
        touched.push(name);
        await flush(path.dirname(path.join(folder, name)));
      }
      const actual = await snapshot(folder, false);
      if (fingerprint(actual.files) !== fingerprint(desired)) throw new Error('The copied save set did not verify.');
    } catch (error) {
      const failures = [];
      for (const name of touched.reverse()) {
        try {
          // Never overwrite a newer external save while undoing owned writes.
          await requireValue(name, desired[name]);
          if (before[name]) await atomic(path.join(folder, name), before[name].buffer, before[name].mtime, path.dirname(folder));
          else await fs.unlink(path.join(folder, name)).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
        } catch (failure) { failures.push(failure.message); }
      }
      if (failures.length) error.rollbackFailed = failures;
      throw error;
    }
  }
  function changed(before, desired) {
    return [...new Set([...Object.keys(before), ...Object.keys(desired)])].filter(name => before[name]?.sha256 !== desired[name]?.sha256).length;
  }

  return {
    async status() {
      try {
        checkedContext();
        const {id, state} = await account();
        const recovery = await fs.lstat(recoveryPath).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
        const other = await fs.lstat(lockPath).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
        return {...state, appId: APP, accountId: id, available: !recovery,
          ...(recovery ? {reason: 'A previous Cloud operation has an uncertain result. Check Steam before retrying.'} : {}),
          busy: busy || other || Boolean(await isBusy()), recoveryRequired: recovery};
      } catch (error) { return {available: false, reason: error.message, busy, appId: APP}; }
    },
    async preview(direction, onProgress) {
      return locked(async () => {
        pending = null;
        if (!['download', 'upload'].includes(direction)) throw new Error('Choose Cloud download or upload.');
        await idle();
        const ctx = checkedContext(), {id} = await account(), backups = [];
        // Validate native paths before allowing the adapter to change Steam data.
        const nativeBefore = await snapshot(ctx.paths.arm64, false);
        const cloud = await down(ctx, id, onProgress, backups, direction === 'upload');
        const native = await snapshot(ctx.paths.arm64, false);
        if (fingerprint(nativeBefore.files) !== fingerprint(native.files)) throw new Error('Native saves changed during the Cloud preview.');
        const source = direction === 'download' ? cloud.files : native.files;
        const destination = direction === 'download' ? native.files : cloud.files;
        validate(source, true);
        if (direction === 'upload' && [...Object.keys(cloud.files), ...cloud.cachePaths].some(name => !native.files[name]))
          throw new Error('Cloud has saves missing from ARM64. Download Cloud first or merge local saves before uploading; Cloud files are never deleted automatically.');
        const count = changed(destination, source), token = crypto.randomUUID();
        pending = {token, direction, key: ctx.key, accountId: id,
          steam: fingerprint(cloud.files), arm64: fingerprint(native.files), backups,
          pendingUpload: cloud.pendingUpload, cacheToken: cloud.cacheToken};
        return {token, direction, sourceLabel: direction === 'download' ? 'Steam Cloud' : 'ARM64 saves',
          destinationLabel: direction === 'download' ? 'ARM64 saves' : 'Steam Cloud', fileCount: Object.keys(source).length,
          changedCount: count, sourceDate: latest(source), destinationDate: cloud.pendingUpload ? null : latest(destination),
          unchanged: count === 0 && !cloud.pendingUpload, pendingUpload: cloud.pendingUpload,
          warning: direction === 'download' ?
            'Replaces the complete ARM64 save set, including settings and backup generations. Local-only saves are removed after backup.' +
              (native.unknown.length ? ' Unrecognized native files are kept.' : '') :
            (cloud.pendingUpload ? 'Steam has local changes waiting to upload. Local copies may already match, but the Cloud upload is still pending. ' : '') +
              'Replaces the matching Cloud saves with the complete ARM64 set, including settings and backup generations. Existing Steam files are backed up; no Cloud files are deleted.'};
      });
    },
    async sync(token, onProgress) {
      return locked(async () => {
        const approved = pending; pending = null;
        if (!approved || typeof token !== 'string' || approved.token !== token) throw new Error('Preview and confirm this Cloud transfer first.');
        await idle();
        const ctx = checkedContext();
        if (ctx.key !== approved.key) throw new Error('Game setup changed. Preview again.');
        await account(approved.accountId);
        const backups = [...approved.backups];
        const initialSteam = await snapshot(ctx.paths.steam, true), initialNative = await snapshot(ctx.paths.arm64, false);
        if (fingerprint(initialSteam.files) !== approved.steam || fingerprint(initialNative.files) !== approved.arm64)
          throw new Error('Save files changed after the preview. Preview again.');
        // Refresh remote state at confirmation; a preview is not a Cloud lease.
        const cloud = await down(ctx, approved.accountId, onProgress, backups, approved.direction === 'upload');
        const native = await snapshot(ctx.paths.arm64, false);
        if (fingerprint(cloud.files) !== approved.steam || fingerprint(native.files) !== approved.arm64 ||
            cloud.pendingUpload !== approved.pendingUpload || cloud.cacheToken !== approved.cacheToken)
          throw new Error('Cloud or native saves changed after the preview. Preview again.');
        const source = approved.direction === 'download' ? cloud.files : native.files;
        const destination = approved.direction === 'download' ? native.files : cloud.files;
        validate(source, true);
        if (approved.direction === 'upload' && [...Object.keys(cloud.files), ...cloud.cachePaths].some(name => !native.files[name]))
          throw new Error('Steam has saves missing from ARM64. Merge local saves before uploading; no Cloud files were deleted.');
        const count = changed(destination, source);
        if (!count && !cloud.pendingUpload) return {message: 'Saves already match. No overwrite was needed.', backupPaths: backups, files: Object.keys(source).length};
        const target = approved.direction === 'download' ? ctx.paths.arm64 : ctx.paths.steam;
        backups.push(await backup(approved.direction === 'download' ? 'native-before-download' : 'steam-before-upload', destination,
          {accountId: approved.accountId, direction: approved.direction, intended: manifest(source)}));
        await idle(); await account(approved.accountId);
        if (checkedContext().key !== ctx.key || fingerprint((await snapshot(target, approved.direction === 'upload')).files) !== fingerprint(destination) ||
            fingerprint((await snapshot(approved.direction === 'download' ? ctx.paths.steam : ctx.paths.arm64, approved.direction === 'download')).files) !== fingerprint(source))
          throw new Error('Save files or setup changed before copying. Preview again.');
        progress(onProgress, approved.direction === 'download' ? 'Copying Cloud saves to ARM64…' : 'Preparing Steam Cloud upload…');
        try { await replaceSet(target, destination, source); }
        catch (error) {
          if (error.rollbackFailed) await recover('Local save restoration needs review.', {backupPaths: backups, failures: error.rollbackFailed});
          error.backupPaths = backups; throw error;
        }
        if (approved.direction === 'upload') {
          try {
            await idle(); await account(approved.accountId);
            const result = await steam.sync('up', relay(onProgress));
            await account(approved.accountId);
            verifyRemote(result, approved.accountId, source);
            if (fingerprint((await snapshot(ctx.paths.steam, true)).files) !== fingerprint(source))
              throw new Error('Steam saves changed during upload.');
          } catch (error) {
            let restored = false;
            if (error.quiescent === true) {
              try {
                await idle(); await account(approved.accountId);
                if (fingerprint((await snapshot(target, true)).files) !== fingerprint(source)) throw new Error('Steam staging changed.');
                await replaceSet(target, source, destination); restored = true;
              } catch (failure) { error.restoreError = failure.message; }
            }
            if (!restored) await recover('Cloud upload has an uncertain result; staged Steam files may still upload when the launcher exits.',
              {accountId: approved.accountId, backupPaths: backups, intended: manifest(source), error: error.message});
            error.backupPaths = backups;
            error.message = `${error.message} Cloud may already contain some uploaded files. ` + (restored ?
              'Previous Steam files were restored locally; the remote result still needs checking.' :
              'Staged Steam files and backups were retained; closing the launcher may trigger Steam synchronization. Check Steam before retrying.');
            throw error;
          }
        }
        return {message: approved.direction === 'download' ? 'Cloud saves copied to ARM64.' : 'ARM64 saves uploaded to Steam Cloud.',
          backupPaths: backups, files: Object.keys(source).length};
      });
    },
  };
}

module.exports = {createCloudSync};
