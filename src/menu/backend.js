(() => {
  'use strict';
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const root = path.resolve(process.cwd(), '..');
  const home = fs.realpathSync(os.homedir());
  const {createSaveTransfer, parseGameSave, prepareSlotSelection} = require(path.join(root, 'save-transfer.cjs'));
  const {createSetup} = require(path.join(root, 'setup.cjs'));
  const {createSteamCloud} = require(path.join(root, 'steam-cloud.cjs'));
  const {createCloudSync} = require(path.join(root, 'cloud-sync.cjs'));
  const {createSteamShortcut} = require(path.join(root, 'steam-shortcut.cjs'));
  const {createUninstall} = require(path.join(root, 'uninstall.cjs'));
  const {createControllerEmulation} = require(path.join(root, 'controller-emulation.cjs'));
  const hashes = {
    demo: '9d229ef692aff28cbd7ede74652b6948703ac49bb4f44c91762353ae5041a38f',
    full: 'da41f4969f915076c61d4e3bc80a0e1679344f833ac5ede4f70b2a9217e53547',
  };
  const generations = ['Default', 'Backups', 'Backups2'];
  const legacyID = 'Auxiliary:legacy-System.save';
  const legacyName = 'Default\\Saves\\Default\\System.save';
  const saveName = /^(?:Save_ID_(?:auto|[0-9]{4,16})|System)\.save$/;
  let operationBusy = false;
  let transfer = null;
  let pendingContext = null;
  const setup = createSetup({root, home, nativeDataPath: nw.App.dataPath, isBusy: gameIsRunning});
  const steamCloud = createSteamCloud({home, context: checkedContext});
  const cloud = createCloudSync({root, context: checkedContext, isBusy: gameIsRunning, steam: steamCloud});
  const steamShortcut = createSteamShortcut({root, home});
  const controller = createControllerEmulation({isBusy: gameIsRunning});
  const uninstaller = createUninstall({root, home, isBusy: gameIsRunning,
    removeSteamShortcut: () => steamShortcut.remove()});
  const shortcutPending = path.join(root, '.steam-shortcut-pending');
  const contextKey = context => context && JSON.stringify([context.variant, context.gameDir, context.bundlePath,
    context.bundleSha256, context.steamProfile, context.nativeDataPath]);

  function checkedDirectory(directory) {
    let current = path.parse(directory).root;
    for (const component of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A save directory is linked or invalid. No files were copied.');
    }
    return true;
  }
  function list(directory) {
    return checkedDirectory(directory) ? fs.readdirSync(directory).sort() : [];
  }
  function locations(context) {
    const nativeParent = path.dirname(context.nativeDataPath);
    if (path.basename(context.nativeDataPath) !== 'Default')
      throw new Error('This native save-profile layout has not been checked. Play remains available.');
    return context.variant === 'full' ? {
      roots: {steam: context.steamProfile, arm64: nativeParent},
      parents: {steam: context.steamProfile, arm64: nativeParent}, prefixes: null,
    } : {
      roots: {steam: context.steamProfile, arm64: nativeParent},
      parents: {steam: context.steamProfile, arm64: nativeParent}, prefixes: {steam: 'Default', arm64: 'Default'},
    };
  }
  function inspectLayout(context) {
    const loc = locations(context);
    const listing = {}, sides = {};
    for (const side of ['steam', 'arm64']) {
      listing[side] = [];
      const state = sides[side] = {legacy: [], legacyTrigger: false, error: null};
      try {
        const parentEntries = list(loc.parents[side]);
        state.legacy = parentEntries.filter(name => /^Default\\Saves\\(?:Default|Backups|Backups2)\\(?:Save_ID_(?:auto|[0-9]{4,16})|System)\.save$/.test(name));
        state.legacyTrigger = state.legacy.includes(legacyName);
        if (context.variant === 'demo') {
          listing[side] = state.legacy;
          if (generations.some(generation => list(path.join(loc.parents[side], 'Saves', generation)).some(name => saveName.test(name))))
            state.error = 'This profile also contains full-game saves. Demo save copying is disabled to keep the editions separate.';
        } else {
          listing[side] = generations.flatMap(generation => list(path.join(loc.roots[side], 'Saves', generation))
            .filter(name => saveName.test(name)).map(name => `${generation}/${name}`));
          // Full 0.2.0-9 copies legacy files and removes only its primary
          // System.save trigger. Other flat residues are normal after migration.
          if (state.legacy.length && !state.legacyTrigger && !listing[side].includes('Default/System.save'))
            state.error = 'Legacy saves remain without a current full-game System.save. The original full game must finish that migration before this profile can be copied.';
        }
      } catch (error) { state.error = error.message; }
    }
    return {loc, listing, sides};
  }
  function directionSupport(context, layout = inspectLayout(context)) {
    return Object.fromEntries([['steam-to-arm64', 'steam', 'arm64'], ['arm64-to-steam', 'arm64', 'steam']].map(([direction, source, destination]) => {
      const from = layout.sides[source], to = layout.sides[destination];
      let reason = from.error || to.error;
      if (!reason && context.variant === 'full') {
        if (from.legacyTrigger) reason = 'The source still uses the old demo save index. It cannot be imported as full-game progress.';
        else if (to.legacyTrigger && !(direction === 'arm64-to-steam' && layout.listing[destination].length === 0))
          reason = 'The destination mixes old demo and full-game saves. Resolve its migration in the original full game before copying.';
      }
      const allOnly = !reason && context.variant === 'full' && to.legacyTrigger;
      return [direction, {supported: !reason, allOnly,
        ...(reason ? {reason} : allOnly ? {reason: 'Choose All for the first ARM64 → Steam copy to replace the old demo index safely.'} : {})}];
    }));
  }
  function saveSupport(context) {
    if (!context) return {supported: false, reason: 'Install the ARM64 setup before copying local saves.'};
    if (!hashes[context.variant] || context.bundleSha256 !== hashes[context.variant])
      return {supported: false, reason: 'Save copying has not been checked for this game version. Play remains available.'};
    return {supported: true, reason: context.variant === 'full' ?
      'Local save layout checked for 0.2.0-9. Loading transferred saves in the full game has not yet been tested.' : ''};
  }
  function checkedContext() {
    const context = setup.getContext();
    const support = saveSupport(context);
    if (!support.supported) throw new Error(support.reason);
    const stat = fs.statSync(context.bundlePath);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024 ||
        crypto.createHash('sha256').update(fs.readFileSync(context.bundlePath)).digest('hex') !== hashes[context.variant])
      throw new Error('The game version changed. Reopen the menu before copying saves.');
    return context;
  }
  function discoverFiles(context) {
    const {listing} = inspectLayout(context);
    const slots = new Set(['Save_ID_auto.save', ...Array.from({length: 10}, (_, i) => `Save_ID_${String(i + 1).padStart(4, '0')}.save`)]);
    for (const names of Object.values(listing)) for (const file of names) {
      const name = file.split(/[\\/]/).pop();
      if (name !== 'System.save') slots.add(name);
    }
    if (slots.size > 256) throw new Error('Too many save slots for this launcher version. No files were copied.');
    // System.save follows slot files within each generation so its index is not
    // published before the associated current slot bytes have been installed.
    const entries = generations.flatMap(generation => [...slots].sort().concat('System.save').map(name => ({
      id: `${generation}:${name}`,
      steam: context.variant === 'full' ? `Saves/${generation}/${name}` : `Default\\Saves\\${generation}\\${name}`,
      arm64: context.variant === 'full' ? `Saves/${generation}/${name}` : `Default\\Saves\\${generation}\\${name}`,
    })));
    if (context.variant === 'full') entries.push({id: legacyID, steam: legacyName, arm64: legacyName, auxiliary: true, removable: true});
    return entries;
  }
  function validateFile(name, bytes) {
    const data = parseGameSave(name, bytes);
    if (name.endsWith(':System.save')) {
      const validID = id => id === null || id === 'auto' || (Number.isSafeInteger(id) && id >= 0);
      if (!validID(data.lastUsedID) || ['lastUsedManualID', 'autoSaveLastManualID'].some(key =>
          Object.hasOwn(data, key) && !validID(data[key]))) throw new Error('System.save has an unsupported last-used slot.');
      for (const [key, entry] of Object.entries(data.meta)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
            !validID(entry.id) || String(entry.id) !== key || !entry.sub || typeof entry.sub !== 'object' || Array.isArray(entry.sub))
          throw new Error('System.save contains an unsupported slot index.');
      }
    }
  }
  async function gameIsRunning() {
    let context;
    try { context = setup.getContext(); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    let sourceDir = context?.gameDir;
    if (!sourceDir) {
      // A moved/deleted game must not prevent repairing or removing its setup.
      // Retain its recorded path for process matching even if it no longer exists.
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'setup.json'), 'utf8'));
        if (saved.schema === 1 && typeof saved.gamePath === 'string' && path.isAbsolute(saved.gamePath)) sourceDir = saved.gamePath;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const ownMain = Number(fs.readFileSync(path.join(root, 'logs/latest.pid'), 'utf8').trim());
    if (!Number.isSafeInteger(ownMain) || ownMain < 2) throw new Error('Cannot check the running game. Restart the launcher.');
    const processes = new Map();
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const proc = `/proc/${name}`;
      try {
        if (fs.statSync(proc).uid !== process.getuid()) continue;
        const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
        processes.set(Number(name), {ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), proc,
          name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))});
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw new Error('Cannot check running games. Close other games and try again.');
      }
    }
    const belongsToMenu = pid => {
      const seen = new Set();
      while (processes.has(pid) && !seen.has(pid)) {
        if (pid === ownMain) return true;
        seen.add(pid); pid = processes.get(pid).ppid;
      }
      return false;
    };
    for (const [pid, entry] of processes) {
      if (belongsToMenu(pid)) continue;
      if (!/^(nw|alabaster|fex|wine|bwrap|pressure-vessel|pv-bwrap)/i.test(entry.name)) continue;
      try {
        const exe = fs.readlinkSync(`${entry.proc}/exe`);
        const cwd = fs.readlinkSync(`${entry.proc}/cwd`);
        // A running original demo can write the shared Steam profile too.
        // Include other Alabaster NW installations, not only the bound full path.
        if (/[\/]alabaster[- _]dawn(?:[- _\/]|$)/i.test(exe) || /[\/]alabaster[- _]dawn(?:[- _\/]|$)/i.test(cwd) ||
            exe.startsWith(root + '/runtime/') || (sourceDir &&
            (exe.startsWith(sourceDir + '/') || cwd === sourceDir || cwd.startsWith(sourceDir + '/')))) return true;
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw new Error('Cannot check running games. Close other games and try again.');
      }
    }
    return false;
  }
  function createTransfer(context) {
    const {loc} = inspectLayout(context);
    return createSaveTransfer({roots: loc.roots, backupRoot: path.join(root, 'save-backups'),
      files: discoverFiles(context), allowSubdirectories: context.variant === 'full',
      inventoryFingerprint: () => JSON.stringify({context: contextKey(setup.getContext()), layout: inspectLayout(context)}),
      isBusy: gameIsRunning, validateFile, prepareSelection: prepareSlotSelection,
      validatePair: ({source, destination, sourceKey, destinationKey, selection}) => {
        const direction = `${sourceKey}-to-${destinationKey}`;
        const support = directionSupport(context)[direction];
        if (!support?.supported) throw new Error(support?.reason || 'This save-copy direction is unavailable.');
        if (context.variant !== 'full') return;
        for (const data of [source, destination]) for (const [name, file] of Object.entries(data))
          validateFile(name === legacyID ? 'Default:System.save' : name, file.buffer);
        if (source[legacyID]) throw new Error('The source still uses the old demo save index.');
        if (destination[legacyID]) {
          if (sourceKey !== 'arm64' || destinationKey !== 'steam' || Object.keys(destination).some(id => id !== legacyID))
            throw new Error('Old demo and full-game destination saves must be resolved before copying.');
          if (selection !== 'all') throw new Error('Choose All for the first ARM64 → Steam copy. Individual slots are available after the old Steam demo index has been replaced safely.');
          if (!source['Default:System.save'] || !Object.keys(source).some(id => /^Default:Save_ID_(?:auto|[0-9]{4,16})\.save$/.test(id)))
            throw new Error('The ARM64 source needs a current full-game System.save and at least one current save or autosave.');
        }
      },
      planTransaction: ({destination}) => context.variant === 'full' && destination[legacyID] ? {
        remove: [legacyID],
        note: 'Backs up the old Steam demo save index, installs the full-game saves, then removes the old index from the active Steam profile. Old demo slot and backup files are retained.',
      } : {},
    });
  }
  async function exclusive(callback) {
    if (operationBusy) throw new Error('Another launcher operation is still running.');
    operationBusy = true;
    try { return await callback(); } finally { operationBusy = false; }
  }
  function pendingShortcutToken() {
    try {
      const stat = fs.lstatSync(shortcutPending);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256)
        throw new Error('The pending Steam setup marker is invalid. Retry from Options.');
      const token = fs.readFileSync(shortcutPending, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('The pending Steam setup marker is invalid. Retry from Options.');
      return token;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function registerSteam(progress) {
    let token = null;
    let markerWarning = '';
    try { token = pendingShortcutToken(); } catch (error) { markerWarning = error.message; }
    try {
      if (!setup.getContext()) return {ok: false, available: true, installed: false, deferred: true};
      try { progress?.({message: 'Adding to Steam…'}); } catch { /* Progress cannot cancel a completed game installation. */ }
      const result = await steamShortcut.ensure();
      if (!result?.ok || !result.installed)
        return {...result, ok: false, warning: result?.warning || 'Steam registration did not complete. Retry from Options.'};
      try {
        if (token && pendingShortcutToken() === token) fs.unlinkSync(shortcutPending);
      } catch (error) { markerWarning = `Steam entry updated, but its setup marker could not be cleared: ${error.message}`; }
      return {...result, warning: [result.warning, markerWarning].filter(Boolean).join(' ')};
    } catch (error) {
      return {ok: false, available: false, installed: false, warning: error.message || 'Steam registration failed. Retry from Options.'};
    }
  }
  window.launcherAPI = {
    controllerStatus: () => controller.status(),
    controllerSet: type => exclusive(() => controller.set(type)),
    cloudStatus: () => cloud.status(),
    cloudPreview: (direction, progress) => exclusive(async () => {
      transfer = null; pendingContext = null;
      return cloud.preview(direction, progress);
    }),
    cloudSync: (token, progress) => exclusive(() => cloud.sync(token, progress)),
    async status() {
      const context = setup.getContext();
      const support = saveSupport(context);
      if (!support.supported) {
        const empty = () => ({count: null, latest: null,
          slots: Array.from({length: 10}, (_, i) => ({id: i + 1, available: false, modified: null, reason: support.reason})),
          autosave: {available: false, modified: null, reason: support.reason}});
        return {steam: empty(), arm64: empty(), busy: operationBusy, saveSupport: support};
      }
      const layout = inspectLayout(context);
      const directions = directionSupport(context, layout);
      const state = await createTransfer(context).status({independent: true});
      for (const side of ['steam', 'arm64']) {
        state[side].detail = layout.sides[side].error || (layout.sides[side].legacyTrigger ? 'Old demo saves; full-game transfer not yet completed.' : '');
        if (state[side].error) for (const item of Object.values(directions)) { item.supported = false; item.reason = state[side].error; }
      }
      const any = Object.values(directions).some(item => item.supported);
      return {...state, busy: operationBusy || state.busy, directionSupport: directions,
        saveSupport: any ? support : {supported: false, reason: Object.values(directions).find(item => item.reason)?.reason || 'No save-copy direction is available.'}};
    },
    preview(direction, selection = 'all') {
      return exclusive(async () => {
        transfer = null; pendingContext = null;
        const context = checkedContext();
        const next = createTransfer(context);
        const preview = await next.preview(direction, selection);
        transfer = next; pendingContext = contextKey(context);
        return preview;
      });
    },
    sync(direction, selection = 'all') {
      return exclusive(async () => {
        const pending = transfer; const key = pendingContext;
        transfer = null; pendingContext = null;
        if (!pending) throw new Error('Preview the copy first.');
        if (key !== contextKey(checkedContext())) throw new Error('Game setup changed after the preview. Preview again.');
        return pending.sync(direction, selection);
      });
    },
    setupStatus: () => setup.setupStatus(),
    async browseGame() {
      const state = await setup.setupStatus();
      return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.hidden = true;
        input.setAttribute('nwdirectory', '');
        input.setAttribute('nwworkingdir', state.gamePath || state.defaultGamePath);
        const done = value => {input.remove(); resolve(value || null);};
        input.addEventListener('change', () => done(input.files?.[0]?.path || input.value), {once: true});
        input.addEventListener('cancel', () => done(null), {once: true});
        document.body.appendChild(input); input.click();
      });
    },
    install: (gamePath, progress) => exclusive(async () => {
      transfer = null;
      const result = await setup.install(gamePath, progress);
      return {...result, steamShortcut: await registerSteam(progress)};
    }),
    addToSteam: progress => exclusive(() => registerSteam(progress)),
    finishSetup: progress => exclusive(async () => {
      if (!setup.getContext()) return {skipped: true, deferred: true};
      try { if (!pendingShortcutToken()) return {skipped: true}; }
      catch (error) { return {ok: false, warning: error.message}; }
      return registerSteam(progress);
    }),
    uninstall: () => exclusive(async () => {transfer = null; return setup.uninstall();}),
    uninstallPreview: () => exclusive(() => uninstaller.preview()),
    completeUninstall: () => exclusive(async () => {
      transfer = null;
      const result = await uninstaller.uninstall();
      if (result.ok) nw.App.quit();
      return result;
    }),
    play: async () => {
      if (operationBusy) throw new Error('Wait for the current operation to finish.');
      if (!setup.getContext()) throw new Error('Install the ARM64 setup before playing.');
      location.replace(new URL('../terra/index.html', location.href).href);
    },
    exit: async () => {if (!operationBusy) nw.App.quit();},
  };
  if (nw.Window?.get) {
    const nativeWindow = nw.Window.get();
    function closeMenu() { if (!operationBusy) nativeWindow.close(true); }
    nativeWindow.on('close', closeMenu);
    window.addEventListener('pagehide', () => nativeWindow.removeListener('close', closeMenu), {once: true});
  }
})();
