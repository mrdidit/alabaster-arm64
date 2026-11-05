'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const NAME = 'Alabaster Dawn ARM64';
// Steam library.js asset types; sp.js passes raw base64, extension, then type.
const ART = Object.freeze({portrait: 0, hero: 1, logo: 2, wide: 3});
const WRAPPER = '/usr/libexec/armada/armada-game-launch';
const LAUNCH_OPTIONS = `${WRAPPER} %command%`;
const HUD_CONFIG = 'preset=2,no_display=0,position=bottom-right,font_size=18';
const HUD_OPTIONS = `MANGOHUD_CONFIGFILE=/dev/null MANGOHUD_CONFIG=${HUD_CONFIG} mangohud ${LAUNCH_OPTIONS}`;
// Exact known forms only. Do not parse/rewrite arbitrary shell launch options.
const HUD_ENABLED_OPTIONS = Object.freeze([
  HUD_OPTIONS, `mangohud ${LAUNCH_OPTIONS}`,
  `MANGOHUD_CONFIG=${HUD_CONFIG} mangohud ${LAUNCH_OPTIONS}`,
]);
const HUD_KNOWN_OPTIONS = Object.freeze(['', LAUNCH_OPTIONS, ...HUD_ENABLED_OPTIONS]);

function safePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f"\\]/.test(value))
    throw new Error('The launcher path cannot be represented safely as a Steam shortcut.');
  return value;
}
function targets() {
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
    request.on('error', () => reject(new Error('Start Steam and sign in, then retry Add to Steam from Options.')));
  });
}

// Executed only inside Steam's running SharedJSContext. No shortcut file editing.
async function steamAction(p) {
  const apps = globalThis.SteamClient?.Apps;
  if (!apps || typeof apps.RegisterForAppDetails !== 'function' || !globalThis.appStore?.m_mapApps?.values)
    throw new Error('Steam shortcut information is unavailable. Wait for its library to load.');
  if (globalThis.appStore.m_bIsInitialized === false)
    throw new Error('Steam is still loading its library. Try again shortly.');
  const account = globalThis.loginStore?.accountName;
  const checkAccount = () => {
    if (!account || globalThis.loginStore?.loginState !== 5 || globalThis.loginStore.accountName !== account || (p.account && p.account !== account))
      throw new Error('The Steam login changed or is unavailable. Sign in and retry.');
  };
  checkAccount();
  const key = '__alabasterARM64ShortcutLocks';
  if (!(globalThis[key] instanceof Set)) globalThis[key] = new Set();
  if (globalThis[key].has(p.exe)) throw new Error('Steam registration is already in progress.');
  globalThis[key].add(p.exe);
  const bounded = promise => Promise.race([promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Steam did not finish the shortcut request. Check the library before retrying.')), 7000);
    Promise.resolve(promise).then(() => clearTimeout(timer), () => clearTimeout(timer));
  })]);
  function detail(id) {
    return new Promise((resolve, reject) => {
      let subscription, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); subscription?.unregister?.();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Steam did not return complete shortcut details. No duplicate was added.')), 5000);
      try {
        subscription = apps.RegisterForAppDetails(id, value => {
          if (value?.unAppID === id && typeof value.strShortcutExe === 'string') finish(null, value);
        });
        if (settled) subscription?.unregister?.();
      } catch (error) { finish(error); }
    });
  }
  const unquote = value => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
  };
  const localApps = () => Array.from(globalThis.appStore.m_mapApps.values()).filter(item => {
    if (!item || item.app_type !== 1073741824) return false;
    const local = item.local_per_client_data || item.per_client_data?.find(client => client.clientid === '0');
    return Boolean(local);
  });
  // Uninstall requires explicit client-0 evidence. A remote entry or a cached
  // local_per_client_data value for another client is not removal authority.
  const removalLocalApps = () => localApps().filter(item => item.local_per_client_data?.clientid === '0' ||
    item.per_client_data?.some(client => client.clientid === '0'));
  async function scan(entries) {
    if (entries.length > 512) throw new Error('Too many local shortcuts to verify safely. No shortcut was changed.');
    const details = [];
    for (let offset = 0; offset < entries.length; offset += 32) {
      const batch = entries.slice(offset, offset + 32);
      if (batch.some(item => !Number.isInteger(item.appid) || item.appid <= 0 || item.appid > 4294967295))
        throw new Error('Steam returned invalid shortcut identifiers.');
      details.push(...await Promise.all(batch.map(item => detail(item.appid))));
    }
    checkAccount();
    return details;
  }
  const pack = value => ({appId: value.unAppID, exe: value.strShortcutExe,
    startDir: value.strShortcutStartDir, launchOptions: typeof value.strShortcutLaunchOptions === 'string' ? value.strShortcutLaunchOptions : value.strLaunchOptions,
    name: value.strDisplayName, compatTool: value.strCompatToolName || ''});
  const canCreate = ['AddShortcut', 'SetShortcutName', 'SetShortcutExe', 'SetShortcutStartDir', 'SetShortcutLaunchOptions', 'SetCustomArtworkForApp'].every(name => typeof apps[name] === 'function');
  const artworkAvailable = typeof apps.SetCustomArtworkForApp === 'function';
  try {
    if (p.action === 'artwork') {
      if (typeof apps.SetCustomArtworkForApp !== 'function') throw new Error('Steam does not support custom shortcut artwork.');
      if (!localApps().some(item => item.appid === p.appId)) throw new Error('The local Steam shortcut disappeared. Retry registration.');
      const value = await detail(p.appId);
      if (unquote(value.strShortcutExe) !== p.exe) throw new Error('The Steam shortcut target changed. No artwork was applied.');
      checkAccount();
      await bounded(apps.SetCustomArtworkForApp(p.appId, p.base64, 'png', p.assetType));
      checkAccount();
      return {account, appId: p.appId, applied: true};
    }
    const removing = p.action === 'remove' || p.action === 'remove-status';
    const hud = p.action === 'hud-status' || p.action === 'hud-set';
    const details = await scan(removing || hud ? removalLocalApps() : localApps());
    const matches = details.filter(item => unquote(item.strShortcutExe) === p.exe);
    if (hud) {
      const writable = typeof apps.SetShortcutLaunchOptions === 'function';
      if (p.action === 'hud-status') return {ok: true, available: true, account, installed: matches.length > 0,
        matches: matches.map(pack), writable};
      if (matches.length !== 1) throw new Error(matches.length ?
        'More than one Steam entry points to this launcher. Remove the duplicate before changing MangoHud.' :
        'Add this launcher to Steam from Options before changing MangoHud.');
      if (!writable) throw new Error('This Steam version cannot update launch options. Set them manually in Steam.');
      if (!p.expected || !Number.isInteger(p.expected.appId) || typeof p.expected.launchOptions !== 'string' ||
          !Array.isArray(p.knownOptions) || !p.knownOptions.includes(p.expected.launchOptions) ||
          typeof p.launchOptions !== 'string' || !p.knownOptions.includes(p.launchOptions))
        throw new Error('The MangoHud review is incomplete. Reopen its settings before applying.');
      let value = pack(matches[0]);
      const expected = () => value.appId === p.expected.appId && value.launchOptions === p.expected.launchOptions &&
        unquote(value.exe) === p.exe && removalLocalApps().some(item => item.appid === value.appId);
      if (!expected()) throw new Error('The Steam entry or launch options changed. Reopen MangoHud settings before applying.');
      // Recheck immediately before the setter. Steam provides no atomic CAS API.
      value = pack(await detail(value.appId));
      checkAccount();
      if (!expected()) throw new Error('The Steam entry or launch options changed. Nothing was overwritten.');
      if (value.launchOptions === p.launchOptions)
        return {ok: true, available: true, installed: true, account, changed: false, ...value};
      try {
        await bounded(apps.SetShortcutLaunchOptions(value.appId, p.launchOptions));
        checkAccount();
        for (let attempt = 0; attempt < 8; attempt++) {
          value = pack(await detail(p.expected.appId));
          checkAccount();
          if (unquote(value.exe) !== p.exe || !removalLocalApps().some(item => item.appid === value.appId))
            throw new Error('The Steam entry changed during the update. Check its launch options in Steam.');
          if (value.launchOptions === p.launchOptions)
            return {ok: true, available: true, installed: true, account, changed: true, ...value};
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Steam did not confirm the new launch options. Check them in Steam before retrying.');
      } catch (error) {
        return {ok: false, account, uncertain: true, error: error.message};
      }
    }
    if (p.action === 'remove-status')
      return {ok: true, account, matches: matches.map(item => item.unAppID).sort((a, b) => a - b)};
    if (p.action === 'remove') {
      const removed = [];
      try {
        const ids = matches.map(item => item.unAppID).sort((a, b) => a - b);
        if (!Array.isArray(p.expected) || JSON.stringify(ids) !== JSON.stringify(p.expected))
          throw new Error('The Steam shortcut inventory changed. Preview uninstall again.');
        if (ids.length && typeof apps.RemoveShortcut !== 'function') throw new Error('Steam cannot remove shortcuts in this client version.');
        const deadline = Date.now() + 15000;
        for (const id of ids) {
          checkAccount();
          if (Date.now() >= deadline) throw new Error('Steam shortcut removal timed out. Check the library before retrying.');
          if (!removalLocalApps().some(item => item.appid === id))
            throw new Error('The local shortcut changed before removal. Retry uninstall.');
          const value = await detail(id);
          checkAccount();
          if (unquote(value.strShortcutExe) !== p.exe)
            throw new Error('A shortcut target changed before removal. It was left unchanged.');
          // Installed Steam sp.js calls Apps.RemoveShortcut(appId), one argument.
          await bounded(apps.RemoveShortcut(id));
          checkAccount();
          let absent = false;
          for (let attempt = 0; attempt < 40 && Date.now() < deadline; attempt++) {
            checkAccount();
            absent = !removalLocalApps().some(item => item.appid === id);
            if (absent) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!absent) throw new Error(`Steam did not confirm removal of shortcut ${id}. Installation files were not removed.`);
          removed.push(id);
        }
        const remaining = (await scan(removalLocalApps())).filter(item => unquote(item.strShortcutExe) === p.exe);
        checkAccount();
        if (remaining.length) throw new Error('A matching local shortcut remains or was added during removal. Retry uninstall.');
        return {ok: true, account, removed, installed: false};
      } catch (error) {
        // Return the confirmed subset across CDP; throwing here would discard
        // structured partial progress from the remote JavaScript exception.
        return {ok: false, account, removed, error: error.message};
      }
    }
    if (matches.length > 1) throw new Error('More than one local Steam shortcut points to this launcher. Remove the duplicate in Steam before retrying.');
    if (matches.length === 1) {
      const value = pack(matches[0]);
      return {ok: true, available: true, installed: true, canCreate, artworkAvailable, account, ...value, created: false,
        warning: value.compatTool ? 'The existing shortcut uses a compatibility tool. Its settings were preserved; disable forced compatibility to launch the native ARM64 app.' : ''};
    }
    const collision = details.some(item => item.strDisplayName === p.name);
    if (p.action === 'status') return {ok: true, available: true, installed: false, canCreate, artworkAvailable, account, collision};
    if (collision) throw new Error('A different local shortcut already has this name. It was left unchanged. Rename it in Steam, then retry.');
    for (const name of ['AddShortcut', 'SetShortcutName', 'SetShortcutExe', 'SetShortcutStartDir', 'SetShortcutLaunchOptions', 'SetCustomArtworkForApp'])
      if (typeof apps[name] !== 'function') throw new Error(`Steam shortcut API ${name} is unavailable.`);
    checkAccount();
    const id = await bounded(apps.AddShortcut(p.name, p.exe, '', p.exe));
    if (!Number.isInteger(id) || id <= 0 || id > 4294967295) throw new Error('Steam did not return a valid shortcut ID. Check the library before retrying.');
    checkAccount();
    for (const [method, value] of [['SetShortcutName', p.name], ['SetShortcutExe', p.quotedExe], ['SetShortcutStartDir', p.quotedRoot], ['SetShortcutLaunchOptions', p.launchOptions]]) {
      checkAccount();
      await bounded(apps[method](id, value));
      checkAccount();
    }
    // The empty-string contract is declared by Steam's Apps API. No existing
    // shortcut compatibility or controller preference is modified.
    if (typeof apps.SpecifyCompatTool === 'function') await bounded(apps.SpecifyCompatTool(id, ''));
    checkAccount();
    let value;
    for (let attempt = 0; attempt < 8; attempt++) {
      value = pack(await detail(id));
      if (value.name === p.name && value.exe === p.quotedExe && value.startDir === p.quotedRoot && value.launchOptions === p.launchOptions && !value.compatTool) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (value.name !== p.name || value.exe !== p.quotedExe || value.startDir !== p.quotedRoot || value.launchOptions !== p.launchOptions || value.compatTool)
      throw new Error(`Steam created shortcut ${id}, but its native launch settings could not be verified. Check that entry before retrying.`);
    checkAccount();
    return {ok: true, available: true, installed: true, account, ...value, created: true, warning: ''};
  } finally { globalThis[key].delete(p.exe); }
}

function createSteamShortcut({root, home = os.homedir(), WebSocket: Socket = globalThis.WebSocket,
  evaluate: testEvaluate, wrapperPath = WRAPPER} = {}) {
  root = safePath(fs.realpathSync(root));
  home = fs.realpathSync(home);
  const exe = safePath(path.join(root, 'alabaster-dawn.arm64'));
  const receiptPath = path.join(root, 'steam-shortcut.json');
  const pendingPath = path.join(root, 'steam-shortcut-pending.json');
  let busy = false;
  let hudReview = null;
  let hudUncertain = false;
  async function evaluate(payload) {
    const expression = `(${steamAction.toString()})(${JSON.stringify(payload)})`;
    if (testEvaluate) return testEvaluate(expression);
    if (typeof Socket !== 'function') throw new Error('The Steam connection is unavailable in this launcher runtime.');
    const list = await targets();
    if (!Array.isArray(list)) throw new Error('Steam returned invalid connection data.');
    const target = list.find(item => item.title === 'SharedJSContext');
    if (!target) throw new Error('Steam is not ready. Wait for its library to load.');
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '8080')
      throw new Error('Steam returned an unexpected local connection.');
    return new Promise((resolve, reject) => {
      const socket = new Socket(url.href);
      let settled = false;
      let dispatched = false;
      const timer = setTimeout(() => finish(new Error('Steam shortcut registration timed out. Check the library before retrying.')), 30000);
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.close();
        if (error && payload.action === 'hud-set' && dispatched && !error.steamActionRejected) error.uncertain = true;
        if (error) reject(error); else resolve(value);
      }
      socket.addEventListener('open', () => {
        try {
          dispatched = true;
          socket.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {
            expression, returnByValue: true, awaitPromise: true, timeout: 25000}}));
        } catch (error) { finish(error); }
      });
      socket.addEventListener('error', () => finish(new Error('Cannot connect to the running Steam client.')));
      socket.addEventListener('close', () => finish(new Error('Steam closed the connection.')));
      socket.addEventListener('message', event => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw new Error('Steam returned invalid shortcut data.');
          const reply = JSON.parse(event.data);
          if (reply.id !== 1) return;
          if (reply.error) throw new Error('Steam rejected the shortcut request.');
          const exception = reply.result?.exceptionDetails;
          if (exception) {
            const error = new Error((exception.exception?.description || exception.text || 'Steam shortcut request failed.').split('\n')[0].replace(/^Error: /, ''));
            error.steamActionRejected = true;
            throw error;
          }
          finish(null, reply.result?.result?.value);
        } catch (error) { finish(error); }
      });
    });
  }
  function payload(action) { return {action, exe, name: NAME, quotedExe: `"${exe}"`, quotedRoot: `"${root}"`}; }
  async function readReceipt(file = receiptPath) {
    let handle;
    try {
      handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536 || stat.uid !== process.getuid()) throw new Error('The Steam shortcut receipt is not a safe regular file.');
      return JSON.parse(await handle.readFile('utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  async function artwork() {
    const result = {};
    for (const [name, type] of Object.entries(ART)) {
      const file = path.join(root, 'menu/assets/steam', `${name}.png`);
      const real = await fsp.realpath(file);
      if (real !== file) throw new Error('Steam artwork must be regular files inside the launcher.');
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 16 * 1024 * 1024) throw new Error(`Steam ${name} artwork is invalid.`);
      const data = await fsp.readFile(file);
      if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Steam ${name} artwork is not PNG.`);
      result[name] = {type, data, sha256: crypto.createHash('sha256').update(data).digest('hex')};
    }
    return result;
  }
  async function status() {
    try { return await evaluate(payload('status')); }
    catch (error) { return {ok: false, available: false, installed: false, warning: error.message}; }
  }
  async function hudStatus() {
    hudReview = null;
    const base = {manualLaunchOptions: HUD_OPTIONS, enabled: false, supported: false, token: null, launchOptions: null};
    try {
      const result = await evaluate(payload('hud-status'));
      if (!result?.ok || !result.account || !Array.isArray(result.matches)) throw new Error('Steam returned incomplete shortcut details. Try again.');
      if (result.matches.length !== 1) return {...base, ok: true, available: true, installed: result.matches.length > 0,
        reason: result.matches.length ? 'More than one Steam entry points to this launcher. Remove the duplicate before changing MangoHud.' :
          'Add this launcher to Steam from Options before changing MangoHud.'};
      const value = result.matches[0];
      if (!Number.isInteger(value.appId) || value.appId <= 0 || value.appId > 4294967295 || typeof value.launchOptions !== 'string')
        throw new Error('Steam did not return the current launch options. Set them manually in Steam.');
      const known = HUD_KNOWN_OPTIONS.includes(value.launchOptions);
      const supported = known && result.writable === true && !hudUncertain && !busy;
      const token = supported ? crypto.randomUUID() : null;
      if (supported) hudReview = {token, account: result.account, appId: value.appId, launchOptions: value.launchOptions};
      return {...base, ok: true, available: true, installed: true, supported, ...value,
        enabled: HUD_ENABLED_OPTIONS.includes(value.launchOptions), token, uncertain: hudUncertain,
        reason: hudUncertain ? 'The previous update could not be verified. Check launch options in Steam, then close and reopen this launcher.' :
          busy ? 'Wait for the current Steam shortcut operation to finish.' :
          !known ? 'Custom launch options are kept unchanged. Add MangoHud manually in Steam using the line below.' :
          !result.writable ? 'This Steam version cannot update launch options. Set them manually in Steam.' : ''};
    } catch (error) {
      return {...base, ok: false, available: false, installed: false,
        reason: error.message, uncertain: hudUncertain};
    }
  }
  async function hudSet(enabled, {token, expectedLaunchOptions} = {}) {
    if (typeof enabled !== 'boolean' || typeof token !== 'string' || !token || typeof expectedLaunchOptions !== 'string')
      throw new Error('Choose On or Off from the current MangoHud settings before applying.');
    if (busy) throw new Error('A Steam shortcut operation is already in progress.');
    if (hudUncertain) throw new Error('Check launch options in Steam, then close and reopen this launcher before applying again.');
    const approved = hudReview;
    if (!approved || token !== approved.token || expectedLaunchOptions !== approved.launchOptions)
      throw new Error('MangoHud settings changed or expired. Reopen them before applying.');
    hudReview = null;
    busy = true;
    let result;
    try {
      result = await evaluate({...payload('hud-set'), account: approved.account,
        expected: {appId: approved.appId, launchOptions: approved.launchOptions},
        knownOptions: HUD_KNOWN_OPTIONS, launchOptions: enabled ? HUD_OPTIONS : LAUNCH_OPTIONS});
      if (!result?.ok || result.account !== approved.account || result.appId !== approved.appId ||
          result.launchOptions !== (enabled ? HUD_OPTIONS : LAUNCH_OPTIONS)) {
        hudUncertain = result?.uncertain === true || result?.ok === true;
        const error = new Error(result?.error || 'Steam did not verify the MangoHud launch options. Check them in Steam.');
        error.uncertain = hudUncertain;
        throw error;
      }
    } catch (error) {
      // Transport failure can hide a completed or still-pending remote setter.
      if (error.uncertain === true || (!result && /connection|connect|timed out|timeout|Steam rejected|closed/i.test(error.message))) hudUncertain = true;
      error.uncertain = hudUncertain;
      throw error;
    } finally { busy = false; }
    const after = await hudStatus();
    if (!after.supported || hudReview?.account !== approved.account || after.appId !== approved.appId || after.launchOptions !== result.launchOptions)
      throw new Error('MangoHud was updated, but the current Steam entry changed before final verification. Review it in Steam.');
    return {...after, changed: result.changed, message: enabled ? 'MangoHud is enabled for this Steam entry.' : 'MangoHud is disabled. Armada launch settings were kept.'};
  }
  async function ensure({forceArtwork = false} = {}) {
    if (busy) throw new Error('Steam registration is already in progress.');
    busy = true;
    try {
      const stat = await fsp.stat(exe);
      if (!stat.isFile()) throw new Error('The native launcher is missing. Reinstall the launcher first.');
      await fsp.access(exe, fs.constants.X_OK);
      const images = await artwork();
      const previous = await readReceipt();
      let pending = await readReceipt(pendingPath);
      let wrapper = false;
      try { await fsp.access(wrapperPath, fs.constants.X_OK); wrapper = true; }
      catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
      const desiredOptions = wrapper ? LAUNCH_OPTIONS : '';
      const before = await evaluate(payload('status'));
      if (!before?.ok || !before.available || !before.account) throw new Error('Steam shortcut inventory is incomplete.');
      if (!before.artworkAvailable || (!before.installed && !before.canCreate)) throw new Error('Steam does not provide the required shortcut/artwork APIs. No shortcut was added.');
      if (!before.installed && before.collision) throw new Error('A different local shortcut already has this name. It was left unchanged. Rename it in Steam, then retry.');
      const configured = (value, options) => value.name === NAME && value.exe === `"${exe}"` && value.startDir === `"${root}"` && value.launchOptions === options && !value.compatTool;
      if (pending) {
        if (pending.schema !== 1 || pending.root !== root || pending.account !== before.account)
          throw new Error('An interrupted Steam registration belongs to a different location or login. No shortcut was changed.');
        if (!before.installed || !configured(before, pending.launchOptions))
          throw new Error('An earlier Steam shortcut registration is incomplete. Check its target, start directory and native compatibility settings in Steam before retrying. No duplicate was added.');
        await fsp.unlink(pendingPath);
        pending = null;
      }
      if (!before.installed) {
        pending = {schema: 1, root, account: before.account, launchOptions: desiredOptions, startedAt: new Date().toISOString()};
        await fsp.writeFile(pendingPath, JSON.stringify(pending, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      }
      const result = await evaluate({...payload('ensure'), account: before.account, launchOptions: desiredOptions});
      if (!result?.ok || !result.installed || !Number.isInteger(result.appId) || !result.account)
        throw new Error('Steam registration returned an incomplete result. Check the library before retrying.');
      if (pending) {
        if (!configured(result, pending.launchOptions)) throw new Error('The newly registered shortcut does not have verified native launch settings. Check Steam before retrying.');
        await fsp.unlink(pendingPath);
      }
      const hashes = Object.fromEntries(Object.entries(images).map(([name, value]) => [name, value.sha256]));
      const current = previous?.schema === 1 && previous.root === root && previous.account === result.account && previous.appId === result.appId &&
        JSON.stringify(previous.artwork) === JSON.stringify(hashes);
      const applied = [];
      if (forceArtwork || !current) {
        for (const [name, image] of Object.entries(images)) {
          await evaluate({...payload('artwork'), account: result.account, appId: result.appId, assetType: image.type, base64: image.data.toString('base64')});
          applied.push(name);
        }
      }
      // The receipt records completed API calls, not a readback of Steam's grid.
      const temporary = `${receiptPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fsp.writeFile(temporary, JSON.stringify({schema: 1, root, account: result.account, appId: result.appId,
          artwork: hashes, updatedAt: new Date().toISOString()}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
        await fsp.rename(temporary, receiptPath);
      } finally { await fsp.rm(temporary, {force: true}); }
      return {...result, artwork: {applied, unchanged: !applied.length, hashes}, message: result.created ? 'Added Alabaster Dawn ARM64 to Steam.' : 'The existing Steam shortcut was kept.'};
    } finally { busy = false; }
  }
  async function remove() {
    if (busy) throw new Error('A Steam shortcut operation is already in progress.');
    busy = true;
    try {
      // Exact executable ownership survives renamed/hidden duplicate entries.
      // Removing this installation makes every such local shortcut unusable;
      // names alone and shortcuts for other installations confer no ownership.
      const before = await evaluate(payload('remove-status'));
      if (!before?.ok || !before.account || !Array.isArray(before.matches) || before.matches.some(id =>
        !Number.isInteger(id) || id <= 0 || id > 4294967295)) throw new Error('Steam shortcut inventory is incomplete.');
      const result = await evaluate({...payload('remove'), account: before.account, expected: before.matches});
      const removed = Array.isArray(result?.removed) ? Array.from(result.removed).filter(id => before.matches.includes(id)) : [];
      if (!result?.ok || result.account !== before.account || result.installed !== false ||
          JSON.stringify(removed) !== JSON.stringify(before.matches)) {
        const error = new Error(result?.error || 'Steam shortcut removal could not be verified. Installation files were not removed.');
        error.removed = removed;
        throw error;
      }
      return {ok: true, removed, installed: false};
    } finally { busy = false; }
  }
  return {status, ensure, remove, hudStatus, hudSet};
}

module.exports = {createSteamShortcut};
