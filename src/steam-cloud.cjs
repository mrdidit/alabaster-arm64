'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const APP = 3110760;
const FILE = /^(Default|Backups|Backups2)\/(System|Save_ID_(auto|[0-9]{4,16}))\.save$/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseVDF(text) {
  const tokens = [];
  const pattern = /\s+|\/\/[^\n]*|"((?:\\.|[^"\\])*)"|([{}])/gy;
  let position = 0;
  while (position < text.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    if (!match) throw new Error('Steam metadata has an unsupported format.');
    position = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({value: match[1].replace(/\\([\\"])/g, '$1')});
    else if (match[2]) tokens.push(match[2]);
  }
  let index = 0;
  function object(nested = false, depth = 0) {
    if (depth > 12) throw new Error('Steam metadata is nested too deeply.');
    const result = Object.create(null);
    while (index < tokens.length && tokens[index] !== '}') {
      const key = tokens[index++];
      if (!key || typeof key !== 'object' || Object.hasOwn(result, key.value)) throw new Error('Steam metadata contains invalid keys.');
      const value = tokens[index++];
      if (value === '{') result[key.value] = object(true, depth + 1);
      else if (value && typeof value === 'object') result[key.value] = value.value;
      else throw new Error('Steam metadata contains an invalid value.');
    }
    if (nested && tokens[index++] !== '}') throw new Error('Steam metadata is incomplete.');
    return result;
  }
  const result = object();
  if (index !== tokens.length) throw new Error('Steam metadata has trailing data.');
  return result;
}

function readText(file, limit = 4 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Steam metadata is not a supported regular file.');
  return fs.readFileSync(file, 'utf8');
}

function regularDirectory(directory, missing = false) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (missing && error.code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Cloud save directories must not be symbolic links.');
  }
  return true;
}

function readSteamMarker(file, expectedAccount) {
  const parsed = parseVDF(readText(file, 1024));
  const entry = parsed['steam_autocloud.vdf'];
  if (Object.keys(parsed).length !== 1 || !entry || typeof entry !== 'object' ||
      Object.keys(entry).length !== 1 || !/^[1-9][0-9]{0,9}$/.test(entry.accountid || '') ||
      Number(entry.accountid) > 4294967295 || (expectedAccount !== undefined && entry.accountid !== String(expectedAccount)))
    throw new Error('Steam Cloud account marker is invalid or belongs to a different account.');
  return entry.accountid;
}

function inspectSaveFiles(directory, accountId) {
  const result = Object.create(null);
  if (!regularDirectory(directory, true)) return result;
  let bytes = 0;
  function walk(relative = '') {
    for (const item of fs.readdirSync(path.join(directory, relative), {withFileTypes: true})) {
      const name = relative ? relative + '/' + item.name : item.name;
      if (name === 'steam_autocloud.vdf') { readSteamMarker(path.join(directory, name), accountId); continue; }
      if (item.isDirectory() && !relative && ['Default', 'Backups', 'Backups2'].includes(item.name)) { walk(name); continue; }
      if (!item.isFile() || !FILE.test(name)) throw new Error('Unexpected files in Steam Saves. Cloud sync stopped to avoid transferring unrelated data.');
      const file = path.join(directory, name), before = fs.lstatSync(file);
      if (before.size > 64 * 1024 * 1024 || (bytes += before.size) > 100000000) throw new Error('Cloud saves exceed the supported size.');
      const data = fs.readFileSync(file), after = fs.lstatSync(file);
      if (before.ino !== after.ino || before.size !== data.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new Error('Steam saves changed while being checked. Try again with the game closed.');
      result[name] = {size: data.length, sha1: crypto.createHash('sha1').update(data).digest('hex')};
    }
  }
  walk();
  return result;
}

function cacheState(text) {
  const data = parseVDF(text)[String(APP)];
  if (!data || typeof data !== 'object') throw new Error('The Steam Cloud cache is missing this game.');
  const files = Object.create(null), pendingFiles = [];
  for (const [name, entry] of Object.entries(data)) {
    if (typeof entry === 'string') continue;
    if (!FILE.test(name) || entry.root !== '3' || !/^[a-f0-9]{40}$/i.test(entry.sha || '') || !/^\d+$/.test(entry.size || ''))
      throw new Error('The Steam Cloud save layout differs from the supported full-game layout.');
    // State 3 was captured with Steam's "Need to upload file" result.
    if (!['1', '3'].includes(entry.syncstate) || entry.persiststate !== '0')
      throw new Error('Steam has an unsupported save state or a Cloud conflict. Resolve it in Steam before retrying.');
    if (entry.syncstate === '3') pendingFiles.push(name);
    files[name] = {sha1: entry.sha.toLowerCase(), size: Number(entry.size)};
  }
  if (!/^\d+$/.test(data.ChangeNumber || '')) throw new Error('Steam Cloud revision could not be checked.');
  return {files, pendingFiles, changeNumber: data.ChangeNumber};
}

function cacheFiles(text) {
  const state = cacheState(text);
  if (state.pendingFiles.length) throw new Error('Steam has pending save changes or a Cloud conflict. Resolve it in Steam before retrying.');
  return state.files;
}

function equalFiles(a, b) {
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(k => a[k].size === b[k].size && a[k].sha1 === b[k].sha1);
}

function logResult(text, direction, accountId) {
  const lines = text.split('\n').filter(line => line.includes(`[AppID ${APP}]`));
  const starts = lines.filter(line => line.includes('Starting sync ('));
  if (starts.length > 1) throw new Error('Another Steam Cloud operation overlapped this transfer. Its result needs checking in Steam.');
  if (!starts.length) return {done: false};
  const fields = /Starting sync \(([^)]*)\)/.exec(starts[0]);
  if (!fields) return {done: false};
  if (!fields[1].split(',').map(s => s.trim()).includes(direction))
    throw new Error('A different Steam Cloud operation started. Wait for Steam to finish before retrying.');
  const start = lines.indexOf(starts[0]), active = lines.slice(start);
  for (const line of active) {
    const account = /AutoCloud checking local state for user (\d+)/.exec(line);
    if (account && account[1] !== accountId) throw new Error('Steam changed accounts during the transfer.');
  }
  const conflict = active.find(line => /conflict|result (?!OK\b)[A-Za-z]|sync failed|failed to sync|offline|not logged on/i.test(line));
  if (conflict) {
    const error = new Error('Steam could not finish Cloud sync. Check its Cloud status or conflict dialog before retrying.');
    error.quiescent = /(?:Download|Upload) complete, result (?!OK\b)/i.test(conflict);
    throw error;
  }
  const prefix = direction === 'down' ? 'Download' : 'Upload';
  const complete = active.findIndex(line => line.includes(`${prefix} complete, result OK`) || line.includes(`${prefix} complete in build list`));
  const cacheWritten = active.findIndex((line, index) => index > complete && /YldWriteCacheDirectoryToFile - saved to/.test(line));
  return {done: complete >= 0 && cacheWritten > complete, lines: active};
}

function localTargets() {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:8080/json/list', {timeout: 5000}, response => {
      let text = '';
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Steam connection is unavailable.')); return; }
      response.setEncoding('utf8');
      response.on('data', part => {
        text += part;
        if (text.length > 1024 * 1024) request.destroy(new Error('Steam returned too much connection data.'));
      });
      response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Steam did not answer.')));
    request.on('error', () => reject(new Error('Steam connection is unavailable. Start Steam and try again.')));
  });
}

function createSteamCloud({home, context, WebSocket: Socket = globalThis.WebSocket,
  timeout = 90000, interval = 350, evaluate: testEvaluate,
  originalEntry = [process.env.SteamAppId, process.env.SteamGameId].includes(String(APP))} = {}) {
  let busy = false;
  function steamRoot() {
    for (const candidate of [path.join(home, '.local/share/Steam'), path.join(home, '.steam/steam')]) {
      if (fs.existsSync(path.join(candidate, 'config/loginusers.vdf'))) return fs.realpathSync(candidate);
    }
    throw new Error('Start Steam and sign in before using Cloud sync.');
  }
  async function evaluate(expression) {
    if (testEvaluate) return testEvaluate(expression);
    if (!Socket) throw new Error('The Steam connection is unavailable in this launcher runtime.');
    const target = (await localTargets()).find(item => item.title === 'SharedJSContext');
    if (!target) throw new Error('Steam is not ready. Wait for its library to load.');
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '8080') throw new Error('Steam returned an unexpected local connection.');
    return new Promise((resolve, reject) => {
      const socket = new Socket(url.href);
      const timer = setTimeout(() => finish(new Error('Steam did not answer. Check that it is running.')), 12000);
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.close();
        if (error) reject(error); else resolve(value);
      }
      socket.addEventListener('open', () => socket.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {
        expression, returnByValue: true, awaitPromise: true, timeout: 9000}})));
      socket.addEventListener('error', () => finish(new Error('Cannot connect to the running Steam client.')));
      socket.addEventListener('close', () => finish(new Error('Steam closed the connection.')));
      socket.addEventListener('message', event => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw new Error('Steam returned invalid connection data.');
          const reply = JSON.parse(event.data);
          if (reply.id !== 1) return;
          if (reply.error || reply.result?.exceptionDetails) throw new Error('Steam does not support this Cloud action.');
          finish(null, reply.result?.result?.value);
        } catch (error) { finish(error); }
      });
    });
  }

  async function identity() {
    if (originalEntry) throw new Error('Open the Alabaster Dawn ARM64 shortcut or desktop launcher for Cloud sync. Keep the original Steam game closed.');
    const current = context();
    if (!current || current.variant !== 'full') throw new Error('Cloud sync is available for the installed full game.');
    if (path.resolve(current.steamProfile) !== path.join(home, '.config/Alabaster Dawn'))
      throw new Error('Steam Cloud uses a different save location. This configuration needs checking before sync.');
    const steam = steamRoot();
    const value = await evaluate(`new Promise((resolve,reject)=>{let sub;const t=setTimeout(()=>reject(new Error('timeout')),7000);
      sub=SteamClient.Apps.RegisterForAppDetails(${APP},d=>{clearTimeout(t);setTimeout(()=>sub?.unregister?.(),0);
      resolve({accountName:loginStore.accountName,loginState:loginStore.loginState,folder:d.strInstallFolder,
      compatTool:d.strCompatToolName,cloudEnabled:d.bCloudEnabledForApp,accountCloudEnabled:d.bCloudEnabledForAccount,
      cloudProgress:d.nCloudProgressPercent});});})`);
    if (!value?.accountName || value.loginState !== 5) throw new Error('Sign in to Steam before using Cloud sync.');
    if (!value.cloudEnabled || !value.accountCloudEnabled) throw new Error('Enable Steam Cloud for Alabaster Dawn and this Steam account.');
    if (!['', 'steamlinuxruntime'].includes(value.compatTool)) throw new Error('Select Steam Linux Runtime for the original Alabaster Dawn entry before Cloud sync.');
    if (!value.folder || fs.realpathSync(value.folder) !== fs.realpathSync(current.gameDir)) throw new Error('Steam must have this copy of Alabaster Dawn installed.');
    if (value.cloudProgress > 0 && value.cloudProgress < 100) throw new Error('Steam Cloud is already transferring saves. Wait for it to finish.');
    const users = parseVDF(readText(path.join(steam, 'config/loginusers.vdf'))).users;
    const matches = Object.entries(users || {}).filter(([id, user]) => /^\d{17}$/.test(id) && user.AccountName?.toLowerCase() === value.accountName.toLowerCase());
    if (matches.length !== 1) throw new Error('The active Steam account could not be identified.');
    const id = BigInt(matches[0][0]), base = 76561197960265728n;
    if (id <= base || id > base + 4294967295n) throw new Error('Unsupported Steam account identifier.');
    const accountId = String(id - base);
    return {available: true, appId: APP, accountId, accountName: value.accountName, steam, savePath: path.join(current.steamProfile, 'Saves'),
      cachePath: path.join(steam, 'userdata', accountId, String(APP), 'remotecache.vdf')};
  }

  async function status() {
    try { const {available, appId, accountId} = await identity(); return {available, appId, accountId, reason: ''}; }
    catch (error) { return {available: false, appId: APP, reason: error.message}; }
  }

  async function sync(direction, progress = () => {}) {
    if (!['up', 'down'].includes(direction)) throw new Error('Unknown Steam Cloud direction.');
    if (busy) throw new Error('Steam Cloud is already running.');
    busy = true;
    let commanded = false, completed = false;
    try {
      const before = await identity();
      inspectSaveFiles(before.savePath, before.accountId);
      const log = path.join(before.steam, 'logs/cloud_log.txt');
      const stat = fs.statSync(log), offset = stat.size;
      const report = message => { try { progress({message}); } catch {} };
      report(direction === 'down' ? 'Checking Steam Cloud…' : 'Uploading saves to Steam Cloud…');
      commanded = true;
      const accepted = await evaluate(`(()=>{if(loginStore.accountName!==${JSON.stringify(before.accountName)}||loginStore.loginState!==5)return false;
        SteamClient.Console.ExecCommand('cloud_sync_${direction} ${APP}');return true;})()`);
      if (accepted !== true) { commanded = false; throw new Error('Steam account changed before sync. Preview again.'); }
      const deadline = Date.now() + timeout;
      let lastText = '';
      while (Date.now() < deadline) {
        await delay(interval);
        const now = fs.statSync(log);
        if (now.ino !== stat.ino || now.size < offset || now.size - offset > 4 * 1024 * 1024)
          throw new Error('Steam rotated or replaced the Cloud log during sync. Check its Cloud status before retrying.');
        const fd = fs.openSync(log, 'r');
        const chunk = Buffer.alloc(now.size - offset);
        try { fs.readSync(fd, chunk, 0, chunk.length, offset); } finally { fs.closeSync(fd); }
        const text = chunk.toString('utf8');
        const result = logResult(text, direction, before.accountId);
        if (text !== lastText) {
          const completed = (text.match(new RegExp(`${direction === 'down' ? 'Download' : 'Upload'} OK for file`, 'g')) || []).length;
          if (completed) report(`${direction === 'down' ? 'Downloaded' : 'Uploaded'} ${completed} save files…`);
          lastText = text;
        }
        if (!result.done) continue;
        completed = true;
        const after = await identity();
        if (after.accountId !== before.accountId || after.steam !== before.steam || after.savePath !== before.savePath)
          throw new Error('Steam account or save location changed during sync.');
        const cache = cacheState(readText(after.cachePath));
        const files = inspectSaveFiles(after.savePath, after.accountId);
        if (Object.keys(cache.files).some(name => !files[name] ||
            (!cache.pendingFiles.includes(name) && !equalFiles({[name]: cache.files[name]}, {[name]: files[name]})))) {
          const error = new Error('Steam saves differ from its Cloud record. Resolve pending local changes or conflicts in Steam before retrying.');
          error.quiescent = true; throw error;
        }
        const pendingFiles = [...cache.pendingFiles, ...Object.keys(files).filter(name => !Object.hasOwn(cache.files, name))].sort();
        // Steam can register an uncached file as pending, or refresh local
        // timestamps, without changing either the save bytes or Cloud revision.
        const inventory = Object.keys(files).sort().map(name => [name,
          pendingFiles.includes(name) ? 'pending-local' : 'synced', files[name].sha1, files[name].size]);
        const cacheToken = crypto.createHash('sha256').update(JSON.stringify([cache.changeNumber, inventory])).digest('hex');
        if (pendingFiles.length) {
          if (direction === 'up') throw new Error('Steam upload finished with pending local saves. The Cloud upload could not be verified.');
          report('Local Steam saves are waiting to upload.');
          return {accountId: after.accountId, result: 'pending-local', files, pendingFiles,
            cacheToken, cachePaths: Object.keys(cache.files).sort()};
        }
        report('Steam Cloud transfer verified.');
        return {accountId: after.accountId, result: 'ok', files, cacheToken};
      }
      throw new Error('Steam Cloud did not finish in time. Its remote state is uncertain; check Steam before retrying.');
    } catch (error) {
      if (!commanded || completed) error.quiescent = true;
      throw error;
    } finally { busy = false; }
  }
  return {status, sync};
}

module.exports = {createSteamCloud, parseVDF, cacheFiles, inspectSaveFiles, readSteamMarker, equalFiles, logResult};
