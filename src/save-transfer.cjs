'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const labels = {steam: 'Steam version', arm64: 'ARM64 version'};
const directions = {
  'steam-to-arm64': ['steam', 'arm64'],
  'arm64-to-steam': ['arm64', 'steam'],
};

function normalizeSelection(value = 'all') {
  if (value === 'all') return value;
  const selected = Array.isArray(value) ? Array.from(value) : [value];
  if (!selected.length || selected.some(id => id !== 'auto' && (!Number.isInteger(id) || id < 1 || id > 10)))
    throw new Error('Choose All, Auto or one or more save slots from 1 to 10.');
  return Object.freeze([...new Set(selected)].sort((a, b) => a === b ? 0 : a === 'auto' ? -1 : b === 'auto' ? 1 : a - b));
}

function selectionLabel(selected) {
  const manual = selected.filter(id => id !== 'auto');
  const slots = manual.length ? `${manual.length === 1 ? 'Slot' : 'Slots'} ${manual.join(', ')}` : '';
  return [selected.includes('auto') ? 'Auto' : '', slots].filter(Boolean).join(' + ');
}

function modified(file) {
  if (!file || !Number.isFinite(file.mtime)) return null;
  const date = new Date(file.mtime);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function currentSaveID(name) {
  const match = /^Default:Save_ID_(auto|[0-9]{4,16})\.save$/.exec(name);
  if (!match) return null;
  const id = match[1] === 'auto' ? 'auto' : Number(match[1]);
  return id === 'auto' || Number.isSafeInteger(id) ? id : null;
}

function createSaveTransfer({roots, backupRoot, files, isBusy, validateFile, prepareSelection, inventoryFingerprint, allowSubdirectories = false, validatePair, planTransaction}) {
  if (typeof isBusy !== 'function' || typeof validateFile !== 'function')
    throw new Error('Save validation and running-game checks are required.');
  const validName = name => typeof name === 'string' && name && !name.includes('/') &&
    !name.includes('\0') && name !== '.' && name !== '..';
  if (!Array.isArray(files) || !files.length)
    throw new Error('Save filenames must be a unique list of literal basenames.');
  const entries = files.map(file => typeof file === 'string' ? {id: file, steam: file, arm64: file} : file);
  const validRelative = name => validName(name) || (allowSubdirectories && typeof name === 'string' &&
    !name.includes('\\') && !name.includes('\0') && name.split('/').every(part => validName(part)));
  if (entries.some(file => !file || !validName(file.id) || !['steam', 'arm64'].every(key => validRelative(file[key]))) ||
      ['id', 'steam', 'arm64'].some(key => new Set(entries.map(file => file[key])).size !== entries.length))
    throw new Error('Save filenames must be a unique list of literal basenames.');
  const byId = new Map(entries.map(file => [file.id, {...file}]));
  const filename = (key, id) => byId.get(id)[key];
  const payload = data => Object.fromEntries(Object.entries(data).filter(([id]) => !byId.get(id).auxiliary));
  const folders = Object.fromEntries(['steam', 'arm64'].map(key => [key, path.resolve(roots[key])]));
  const backupFolder = path.resolve(backupRoot);
  if (folders.steam === folders.arm64)
    throw new Error('Steam and ARM64 save directories must be separate.');
  let pending = null;
  let copying = false;

  async function checkedDirectory(directory, create = false) {
    let current = path.parse(directory).root;
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return false;
        try { await fs.mkdir(current, {mode: 0o700}); }
        catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(`Save path is not a regular directory: ${current}`);
    }
    return true;
  }

  async function readFile(directory, name, budget) {
    if (!await checkedDirectory(path.dirname(path.join(directory, name)))) return null;
    let handle;
    try { handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Cannot read save ${name}: ${error.message}`);
    }
    try {
      const before = await handle.stat({bigint: true});
      if (!before.isFile()) throw new Error(`Save is not a regular file: ${name}`);
      if (before.size > BigInt(MAX_FILE) || budget.bytes + Number(before.size) > MAX_TOTAL)
        throw new Error('Save files exceed the supported transfer size.');
      const allocation = Buffer.alloc(Number(before.size) + 1);
      let read = 0;
      while (read < allocation.length) {
        const result = await handle.read(allocation, read, allocation.length - read, null);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      const buffer = allocation.subarray(0, read);
      const after = await handle.stat({bigint: true});
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs || buffer.length !== Number(before.size))
        throw new Error('Save data changed during the read. Close the game and preview again.');
      budget.bytes += buffer.length;
      return {
        buffer, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        mtime: Number(before.mtimeNs) / 1e6,
        identity: [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].map(String),
      };
    } finally { await handle.close(); }
  }

  async function snapshot(key, budget) {
    const output = Object.create(null);
    if (!await checkedDirectory(folders[key])) return output;
    for (const [id, names] of byId) {
      const file = await readFile(folders[key], names[key], budget);
      if (file) output[id] = file;
    }
    return output;
  }

  async function snapshots() {
    const before = inventoryFingerprint ? await inventoryFingerprint() : null;
    const budget = {bytes: 0};
    const data = {steam: await snapshot('steam', budget), arm64: await snapshot('arm64', budget)};
    const after = inventoryFingerprint ? await inventoryFingerprint() : null;
    if (before !== after) throw new Error('Save data changed during the read. Close the game and preview again.');
    if (after !== null && typeof after !== 'string') throw new Error('The save inventory could not be checked.');
    return {...data, inventory: after};
  }

  function fingerprint(data) {
    return JSON.stringify(Object.entries(data).map(([name, file]) => [name, file.sha256, file.identity]));
  }

  async function summary(data) {
    const values = Object.values(data);
    const current = Object.entries(data).filter(([name]) => currentSaveID(name) !== null).map(([, file]) => file);
    async function slot(id) {
      const suffix = `Save_ID_${id === 'auto' ? 'auto' : String(id).padStart(4, '0')}.save`;
      const key = `Default:${suffix}`, file = data[key];
      if (!file) return {id, available: false, modified: null,
        reason: ['Backups', 'Backups2'].some(generation => data[`${generation}:${suffix}`]) ? 'Backup only; no current save.' : 'Empty'};
      try {
        await validateFile(key, file.buffer);
        if (prepareSelection)
          await prepareSelection({selection: [id], source: data, destination: {}});
        return {id, available: true, modified: modified(file)};
      } catch (error) { return {id, available: false, modified: modified(file), reason: error.message}; }
    }
    const slots = [];
    for (let id = 1; id <= 10; id++) slots.push(await slot(id));
    const {id: unused, ...autosave} = await slot('auto');
    return {count: values.length, currentCount: current.length,
      latest: current.length ? modified({mtime: Math.max(...current.map(file => file.mtime))}) : null,
      slots, autosave};
  }

  function directionKeys(direction) {
    if (!Object.hasOwn(directions, direction)) throw new Error('Unknown save-copy direction.');
    return directions[direction];
  }

  async function ensureIdle() {
    if (await isBusy()) throw new Error('Close both versions of Alabaster Dawn before copying saves.');
  }

  async function validateSource(data) {
    if (!Object.keys(data).length) throw new Error('No local saves were found in the selected source.');
    for (const [name, file] of Object.entries(data)) await validateFile(name, file.buffer);
  }

  async function prepare(data, source, destination, requested) {
    const context = {source: data[source], destination: data[destination], sourceKey: source, destinationKey: destination, selection: requested};
    if (validatePair) await validatePair(context);
    async function finish(plan) {
      const extra = planTransaction ? await planTransaction(context) : {};
      const remove = extra.remove || [];
      if (!Array.isArray(remove) || new Set(remove).size !== remove.length || remove.some(id =>
          !byId.get(id)?.auxiliary || !byId.get(id)?.removable || !data[destination][id] || plan.files[id]))
        throw new Error('The additional save operation could not be prepared safely.');
      return {...plan, remove, preservationNote: [plan.preservationNote, extra.note].filter(Boolean).join(' ')};
    }
    if (requested === 'all') {
      const files = payload(data[source]);
      await validateSource(files);
      return finish({files, selectionLabel: 'All local saves',
        preservationNote: 'Includes source settings, autosave and available backup generations. Files absent from the source are kept at the destination.'});
    }
    if (typeof prepareSelection !== 'function')
      throw new Error('Individual save slots are not supported for this game version.');
    const plan = await prepareSelection({selection: requested, source: payload(data[source]), destination: payload(data[destination])});
    if (!plan || !plan.files || typeof plan.files !== 'object' || Array.isArray(plan.files))
      throw new Error('The selected save could not be prepared safely.');
    const prepared = Object.create(null);
    let total = 0;
    for (const [id, file] of Object.entries(plan.files)) {
      if (!byId.has(id) || byId.get(id).auxiliary || !file || !Buffer.isBuffer(file.buffer) || !Number.isFinite(file.mtime))
        throw new Error('The selected save plan contains an invalid file.');
      if (file.buffer.length > MAX_FILE || (total += file.buffer.length) > MAX_TOTAL)
        throw new Error('Save files exceed the supported transfer size.');
      prepared[id] = {...file, buffer: Buffer.from(file.buffer), size: file.buffer.length,
        sha256: crypto.createHash('sha256').update(file.buffer).digest('hex')};
    }
    await validateSource(prepared);
    return finish({files: prepared, selectionLabel: selectionLabel(requested), preservationNote: plan.preservationNote});
  }

  async function writeFile(destination, buffer) {
    const handle = await fs.open(destination, 'wx', 0o600);
    try { await handle.writeFile(buffer); await handle.sync(); }
    finally { await handle.close(); }
  }

  async function flushDirectory(directory) {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); }
    finally { await handle.close(); }
  }

  async function replace(directory, name, file, didReplace = () => {}) {
    const parent = path.dirname(path.join(directory, name));
    await checkedDirectory(parent, true);
    const temporary = path.join(parent, `.alabaster-copy-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, file.buffer);
      await fs.utimes(temporary, new Date(file.mtime), new Date(file.mtime));
      await fs.rename(temporary, path.join(directory, name));
      didReplace();
      await flushDirectory(parent);
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  return {
    async status({independent = false} = {}) {
      if (independent) {
        const result = {};
        for (const key of ['steam', 'arm64']) {
          try { result[key] = await summary(payload(await snapshot(key, {bytes: 0}))); }
          catch (error) { result[key] = {count: null, latest: null, error: error.message,
            slots: Array.from({length: 10}, (_, i) => ({id: i + 1, available: false, modified: null, reason: error.message})),
            autosave: {available: false, modified: null, reason: error.message}}; }
        }
        return {...result, busy: copying || Boolean(await isBusy())};
      }
      const data = await snapshots();
      return {steam: await summary(payload(data.steam)), arm64: await summary(payload(data.arm64)), busy: copying || Boolean(await isBusy())};
    },
    async preview(direction, selected = 'all') {
      pending = null;
      if (copying) throw new Error('A save transfer is already running.');
      const requested = normalizeSelection(selected);
      const [source, destination] = directionKeys(direction);
      await ensureIdle();
      const data = await snapshots();
      const plan = await prepare(data, source, destination, requested);
      pending = {direction, selection: JSON.stringify(requested), steam: fingerprint(data.steam), arm64: fingerprint(data.arm64), inventory: data.inventory};
      const changes = Object.keys(plan.files).filter(name => plan.files[name].sha256 !== data[destination][name]?.sha256);
      const previewEntries = Object.keys(plan.files).filter(name => currentSaveID(name) !== null)
        .map(name => ({id: currentSaveID(name), sourceModified: modified(data[source][name]),
          destinationModified: modified(data[destination][name]), changed: changes.includes(name)}))
        .sort((a, b) => a.id === 'auto' ? -1 : b.id === 'auto' ? 1 : a.id - b.id);
      return {
        sourceCount: Object.keys(plan.files).length,
        destinationCount: requested === 'all' ? Object.keys(payload(data[destination])).length : Object.keys(plan.files).filter(name => data[destination][name]).length,
        sourceLabel: labels[source], destinationLabel: labels[destination],
        changedCount: changes.length + plan.remove.length, overwriteCount: changes.filter(name => data[destination][name]).length, retiredCount: plan.remove.length,
        selection: requested, selectionLabel: plan.selectionLabel, preservationNote: plan.preservationNote, entries: previewEntries,
      };
    },
    async sync(direction, selected = 'all') {
      if (copying) throw new Error('A save transfer is already running.');
      const approval = pending;
      pending = null;
      const requested = normalizeSelection(selected);
      const [source, destination] = directionKeys(direction);
      if (!approval || approval.direction !== direction || approval.selection !== JSON.stringify(requested))
        throw new Error('Preview and confirm this save-copy direction and selection first.');
      copying = true;
      let backup = null;
      const replaced = [];
      let data;
      let planned;
      let manifest;
      try {
        await ensureIdle();
        data = await snapshots();
        if (approval.inventory !== data.inventory || ['steam', 'arm64'].some(key => approval[key] !== fingerprint(data[key])))
          throw new Error('Save data changed after the preview. Preview again before copying.');
        const plan = await prepare(data, source, destination, requested);
        planned = plan.files;
        const changes = Object.keys(planned).filter(name => planned[name].sha256 !== data[destination][name]?.sha256);
        if (!changes.length && !plan.remove.length) return {copied: 0, backup: null};
        await checkedDirectory(backupFolder, true);
        backup = await fs.mkdtemp(path.join(backupFolder, `${new Date().toISOString().replace(/[:.]/g, '-')}-${direction}-`));
        const originals = path.join(backup, 'originals');
        await fs.mkdir(originals, {mode: 0o700});
        manifest = {version: 3, direction, selection: requested, source: folders[source], destination: folders[destination], state: 'prepared', files: []};
        for (const name of [...changes, ...plan.remove]) {
          const previous = data[destination][name];
          if (previous) {
            const saved = path.join(originals, filename(destination, name));
            await checkedDirectory(path.dirname(saved), true);
            await writeFile(saved, previous.buffer);
            await flushDirectory(path.dirname(saved));
          }
          manifest.files.push({name, sourceName: filename(source, name), destinationName: filename(destination, name),
            action: plan.remove.includes(name) ? 'remove' : 'replace',
            previousSha256: previous?.sha256 ?? null, copiedSha256: planned[name]?.sha256 ?? null});
        }
        await writeFile(path.join(backup, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
        await flushDirectory(originals);
        await flushDirectory(backup);
        await flushDirectory(backupFolder);
        await ensureIdle();
        const fresh = await snapshots();
        if (approval.inventory !== fresh.inventory || ['steam', 'arm64'].some(key => approval[key] !== fingerprint(fresh[key])))
          throw new Error('Save data changed while preparing the backup. Preview again before copying.');
        await checkedDirectory(folders[destination], true);
        for (const name of changes) {
          const current = await readFile(folders[destination], filename(destination, name), {bytes: 0});
          if (fingerprint(current ? {[name]: current} : {}) !== fingerprint(data[destination][name] ? {[name]: data[destination][name]} : {}))
            throw new Error('Destination changed during the transfer.');
          await replace(folders[destination], filename(destination, name), planned[name], () => replaced.push(name));
          await flushDirectory(folders[destination]);
        }
        // Retire an explicitly planned auxiliary trigger only after all normal
        // replacements succeeded. Its exact bytes were backed up above.
        for (const name of plan.remove) {
          await ensureIdle();
          const current = await readFile(folders[destination], filename(destination, name), {bytes: 0});
          if (fingerprint(current ? {[name]: current} : {}) !== fingerprint({[name]: data[destination][name]}))
            throw new Error('The legacy save index changed during the transfer.');
          const target = path.join(folders[destination], filename(destination, name));
          await fs.unlink(target);
          replaced.push(name);
          await flushDirectory(path.dirname(target));
        }
        manifest.state = 'complete';
        await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        return {copied: changes.length, ...(plan.remove.length ? {retired: plan.remove.length} : {}), backup};
      } catch (error) {
        const rollbackErrors = [];
        for (const name of replaced.reverse()) {
          try {
            const current = await readFile(folders[destination], filename(destination, name), {bytes: 0});
            if (planned[name] ? current?.sha256 !== planned[name].sha256 : current !== null)
              throw new Error('Destination changed after replacement; automatic restore refused.');
            if (data[destination][name]) await replace(folders[destination], filename(destination, name), data[destination][name]);
            else {
              const target = path.join(folders[destination], filename(destination, name));
              await fs.unlink(target);
              await flushDirectory(path.dirname(target));
            }
            await flushDirectory(folders[destination]);
          } catch (restoreError) { rollbackErrors.push(`${name}: ${restoreError.message}`); }
        }
        if (manifest && backup) {
          manifest.state = rollbackErrors.length ? 'restore-needed' : 'failed-restored';
          manifest.error = error.message;
          manifest.rollbackErrors = rollbackErrors;
          await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n').catch(() => {});
        }
        if (rollbackErrors.length) throw new Error(`${error.message} Restore incomplete; backup: ${backup}. ${rollbackErrors.join(' ')}`);
        throw error;
      } finally { copying = false; }
    },
  };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseGameSave(name, bytes) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`The source save is not readable: ${name}`); }
  const valid = object(data) && object(data.sub) && object(data.meta) &&
    (name.endsWith(':System.save') ? Object.hasOwn(data, 'lastUsedID') : object(data.vars));
  if (!valid) throw new Error(`The save has an unexpected format: ${name}`);
  return data;
}

// Verified demo bundle: 9d229ef6...41a38f. SaveFileList.buildList passes
// SaveButton.get(i+1,i), whose factory sets(index,id). The displayed slots
// 1..10 therefore map to numeric IDs 1..10, padded to four digits by SaveFile.
// The inspected full 0.2.0-9 bundle uses the same slot/metadata mapping. Its
// additional last-used fields are preserved by cloning the destination object.
// Bundle and filesystem-layout compatibility are gated by the caller.
function prepareSlotSelection({selection, source, destination}) {
  const selected = normalizeSelection(selection);
  if (selected === 'all') throw new Error('Choose Auto or one or more manual save slots.');
  const systemKey = 'Default:System.save';
  const selectedSaves = selected.map(id => {
    const key = `Default:Save_ID_${String(id).padStart(4, '0')}.save`;
    const file = source[key];
    if (!file) throw new Error(`${id === 'auto' ? 'Auto' : `Slot ${id}`} has no current source save. Backup-only saves are not copied individually.`);
    return {id, key, file, data: parseGameSave(key, file.buffer)};
  });
  function system(data, required, label) {
    for (const generation of ['Default', 'Backups', 'Backups2']) {
      const key = `${generation}:System.save`;
      if (data[key]) {
        const value = parseGameSave(key, data[key].buffer);
        if (!(value.lastUsedID === null || value.lastUsedID === 'auto' ||
            (Number.isSafeInteger(value.lastUsedID) && value.lastUsedID >= 0)))
          throw new Error(`${label} System.save has an unsupported last-used slot. No files were copied.`);
        return value;
      }
    }
    if (required || Object.keys(data).length)
      throw new Error(`${label} System.save is missing. Individual slots cannot be merged safely.`);
    return {lastUsedID: 0, sub: {}, meta: {}};
  }
  const sourceSystem = system(source, true, 'Source');
  for (const {id} of selectedSaves) {
    const indexed = sourceSystem.meta[String(id)];
    if (!object(indexed) || indexed.id !== id)
      throw new Error(`${id === 'auto' ? 'Auto' : `Slot ${id}`} is not indexed as that slot in source System.save. No files were copied.`);
  }
  const destSystem = system(destination, false, 'Destination');
  const merged = JSON.parse(JSON.stringify(destSystem));
  let metadataChanged = false;
  const files = {};
  for (const {id, key, file, data} of selectedSaves) {
    files[key] = file;
    const oldEntry = destSystem.meta[String(id)];
    if (!object(oldEntry) || oldEntry.id !== id || JSON.stringify(oldEntry.sub) !== JSON.stringify(data.meta)) {
      merged.meta[String(id)] = {id, time: file.mtime, sub: data.meta};
      metadataChanged = true;
    }
  }
  if (selected.includes('auto')) {
    // Full 0.2.0-9 uses this Auto-specific association when Auto is loaded to
    // select a manual-save menu row. It does not copy/write that manual slot.
    // Absence means the game's fallback to slot 1, not the old destination value.
    if (Object.hasOwn(sourceSystem, 'autoSaveLastManualID')) {
      const associated = sourceSystem.autoSaveLastManualID;
      if (!Number.isSafeInteger(associated) || associated < 0)
        throw new Error('Auto has an unsupported manual-slot association. No files were copied.');
      if (!Object.hasOwn(merged, 'autoSaveLastManualID') || merged.autoSaveLastManualID !== associated) metadataChanged = true;
      merged.autoSaveLastManualID = associated;
    } else if (Object.hasOwn(merged, 'autoSaveLastManualID')) {
      delete merged.autoSaveLastManualID;
      metadataChanged = true;
    }
  }
  // Publish all selected index entries together, after their slot files. Keep
  // exact destination bytes when every existing selected entry already matches.
  const systemBuffer = !metadataChanged && destination[systemKey] ? destination[systemKey].buffer :
    Buffer.from(JSON.stringify(merged));
  files[systemKey] = {buffer: systemBuffer,
    mtime: destination[systemKey]?.mtime ?? Math.max(...selectedSaves.map(item => item.file.mtime))};
  return {files,
    preservationNote: `Copies ${selectionLabel(selected)}. Other saves, settings and existing backups are kept.`,
  };
}

module.exports = {createSaveTransfer, parseGameSave, prepareSlotSelection};
