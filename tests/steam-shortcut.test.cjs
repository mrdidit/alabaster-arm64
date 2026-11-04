'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createSteamShortcut} = require('../src/steam-shortcut.cjs');

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'alabaster-steam-shortcut-'));
  const passed = [];
  let number = 0;
  async function fixture() {
    const root = path.join(temporary, `Launcher ${++number} with spaces`);
    const home = temporary, assets = path.join(root, 'menu/assets/steam');
    await fs.mkdir(assets, {recursive: true});
    const exe = path.join(root, 'alabaster-dawn.arm64');
    await fs.writeFile(exe, 'disposable native launcher fixture', {mode: 0o700});
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    for (const name of ['portrait', 'hero', 'logo', 'wide']) await fs.writeFile(path.join(assets, `${name}.png`), png);
    const wrapper = path.join(root, 'wrapper');
    await fs.writeFile(wrapper, 'fixture', {mode: 0o700});
    const calls = [], map = new Map(), details = new Map();
    const state = {next: 3000000000, failArtwork: false, failStartDir: false, switchAccount: false, timerScale: 1};
    const login = {accountName: 'fixture-account', loginState: 5};
    const add = (id, target, {name = 'Alabaster Dawn ARM64', local = true, options = '', compat = '', visible = true} = {}) => {
      map.set(id, {appid: id, app_type: 1073741824, display_name: name, visible_in_game_list: visible,
        per_client_data: [{clientid: local ? '0' : 'remote', installed: true}]});
      details.set(id, {unAppID: id, strDisplayName: name, strShortcutExe: target,
        strShortcutStartDir: '"'+root+'"', strShortcutLaunchOptions: options, strCompatToolName: compat, controllerMapping: 'custom-mapping-retained'});
    };
    const apps = {
      RegisterForAppDetails(id, callback) { callback(details.get(id)); return {unregister() {}}; },
      async AddShortcut(name, target, args, command) {
        calls.push({method: 'add', name, target, args, command}); const id = state.next++;
        add(id, target, {name: state.addUsesBasename ? path.basename(target) : name}); return id;
      },
      SetShortcutName(id, value) { calls.push({method: 'name', id, value}); if (!state.ignoreName) details.get(id).strDisplayName = value; },
      SetShortcutExe(id, value) { calls.push({method: 'exe', id, value}); details.get(id).strShortcutExe = value; },
      SetShortcutStartDir(id, value) { calls.push({method: 'start', id, value}); if (state.failStartDir) throw new Error('fixture start-dir failure'); details.get(id).strShortcutStartDir = value; },
      SetShortcutLaunchOptions(id, value) { calls.push({method: 'options', id, value}); details.get(id).strShortcutLaunchOptions = value; },
      SpecifyCompatTool(id, value) { calls.push({method: 'compat', id, value}); details.get(id).strCompatToolName = value; },
      async SetCustomArtworkForApp(id, data, extension, assetType) {
        calls.push({method: 'art', id, data, extension, assetType});
        if (state.failArtwork && assetType === 2) throw new Error('fixture artwork failure');
        if (state.switchAccount) login.accountName = 'another-account';
      },
      async RemoveShortcut(id) {
        calls.push({method: 'remove', id, argumentCount: arguments.length});
        if (id === state.failRemove) throw new Error('fixture remove failure');
        if (state.ignoreRemove) return;
        const erase = () => { map.delete(id); details.delete(id); };
        if (state.delayRemove) setTimeout(erase, state.delayRemove); else erase();
        if (state.switchOnRemove) login.accountName = 'another-account';
        if (state.afterRemove) state.afterRemove(id);
      },
    };
    const context = vm.createContext({SteamClient: {Apps: apps}, appStore: {m_mapApps: map, m_bIsInitialized: true}, loginStore: login,
      setTimeout: (fn, delay) => setTimeout(fn, Math.max(1, delay * state.timerScale)), clearTimeout});
    const evaluate = expression => vm.runInContext(expression, context, {timeout: 1000});
    const create = extra => createSteamShortcut({root, home, evaluate, wrapperPath: wrapper, ...extra});
    return {root, exe, assets, wrapper, calls, map, details, add, state, login, apps, create, evaluate};
  }
  try {
    {
      const f = await fixture(); f.state.addUsesBasename = true; const result = await f.create().ensure();
      assert.equal(result.ok, true); assert.equal(result.created, true);
      const d = f.details.get(result.appId);
      assert.equal(d.strShortcutExe, '"'+f.exe+'"'); assert.equal(d.strShortcutStartDir, '"'+f.root+'"');
      assert.equal(d.strShortcutLaunchOptions, '/usr/libexec/armada/armada-game-launch %command%');
      assert.equal(d.strDisplayName, 'Alabaster Dawn ARM64'); assert.equal(result.name, 'Alabaster Dawn ARM64');
      assert.deepEqual(f.calls.filter(c => c.method === 'name'), [{method: 'name', id: result.appId, value: 'Alabaster Dawn ARM64'}]);
      assert.equal(d.strCompatToolName, ''); assert.equal(d.controllerMapping, 'custom-mapping-retained');
      const first = f.calls.find(c => c.method === 'add'); assert.equal(first.target, f.exe); assert.equal(first.command, f.exe); assert.equal(first.args, '');
      const art = f.calls.filter(c => c.method === 'art'); assert.equal(art.length, 4);
      assert.deepEqual(art.map(c => c.assetType), [0, 1, 2, 3]); assert(art.every(c => c.extension === 'png' && !c.data.includes('data:')));
      passed.push('Fresh shortcut explicitly sets and reads back its title even when AddShortcut returns a basename, plus native launch settings and four artwork types');
      const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'steam-shortcut.json')));
      assert.equal(receipt.account, 'fixture-account'); assert.equal(receipt.root, f.root); assert.equal(receipt.appId, result.appId);
      const again = await f.create().ensure();
      assert.equal(again.created, false); assert.equal(again.artwork.unchanged, true);
      assert.equal(f.calls.filter(c => c.method === 'add').length, 1); assert.equal(f.calls.filter(c => c.method === 'art').length, 4);
      passed.push('Repeat registration uses live exact target and matching account/root/artwork receipt without duplicates');
      await f.create().ensure({forceArtwork: true}); assert.equal(f.calls.filter(c => c.method === 'art').length, 8);
      passed.push('Explicit artwork retry reapplies assets without creating another shortcut');
    }
    {
      const f = await fixture(); f.add(3000000010, '"'+f.exe+'"', {name: 'Custom existing name', options: 'custom-options', compat: 'custom-proton', visible: false});
      const result = await f.create().ensure();
      assert.equal(result.appId, 3000000010); assert(result.warning.includes('compatibility tool'));
      assert(f.calls.every(c => c.method === 'art')); assert.equal(f.details.get(result.appId).strShortcutLaunchOptions, 'custom-options');
      assert.equal(f.details.get(result.appId).controllerMapping, 'custom-mapping-retained');
      assert.equal(f.details.get(result.appId).strDisplayName, 'Custom existing name');
      passed.push('Hidden exact local shortcut is reused; existing launch/compatibility/controller settings preserved with warning');
    }
    {
      const f = await fixture(); f.add(3000000011, '"'+f.exe+'"', {local: false});
      const result = await f.create().ensure(); assert.equal(result.created, true); assert.notEqual(result.appId, 3000000011);
      assert.equal(f.details.get(3000000011).strShortcutExe, '"'+f.exe+'"');
      passed.push('Remote-only same-name and exact-path shortcut is not mistaken for local ownership');
    }
    {
      const f = await fixture(); f.add(3000000012, '"'+f.exe+'"'); f.add(3000000013, f.exe);
      await assert.rejects(f.create().ensure(), /More than one local/); assert.equal(f.calls.length, 0);
      passed.push('Duplicate exact local targets stop registration without mutation');
    }
    {
      const f = await fixture(); f.add(3000000014, '/unrelated/executable');
      await assert.rejects(f.create().ensure(), /different local shortcut/); assert.equal(f.calls.length, 0);
      await assert.rejects(fs.stat(path.join(f.root, 'steam-shortcut-pending.json')), {code: 'ENOENT'});
      passed.push('Unrelated local name collision remains untouched and creates no pending registration');
    }
    {
      const f = await fixture(); await fs.unlink(f.wrapper);
      const result = await f.create().ensure(); assert.equal(f.details.get(result.appId).strShortcutLaunchOptions, '');
      passed.push('Absent Armada wrapper leaves native launch options empty');
    }
    {
      const f = await fixture(); f.state.failArtwork = true;
      await assert.rejects(f.create().ensure(), /artwork failure/);
      await assert.rejects(fs.stat(path.join(f.root, 'steam-shortcut.json')), {code: 'ENOENT'});
      f.state.failArtwork = false; const result = await f.create().ensure();
      assert.equal(result.created, false); assert.equal(f.calls.filter(c => c.method === 'add').length, 1); assert.equal(result.artwork.applied.length, 4);
      passed.push('Partial artwork failure is visible; retry completes artwork on the original shortcut');
    }
    {
      const f = await fixture(); f.state.failStartDir = true;
      await assert.rejects(f.create().ensure(), /start-dir failure/);
      f.state.failStartDir = false;
      await assert.rejects(f.create().ensure(), /earlier Steam shortcut registration is incomplete/);
      assert.equal(f.calls.filter(c => c.method === 'add').length, 1);
      const d = f.details.get(3000000000); d.strShortcutLaunchOptions = '/usr/libexec/armada/armada-game-launch %command%';
      const result = await f.create().ensure(); assert.equal(result.created, false);
      await assert.rejects(fs.stat(path.join(f.root, 'steam-shortcut-pending.json')), {code: 'ENOENT'});
      passed.push('Interrupted creation cannot masquerade as configured on retry; verified manual completion clears intent without new ID');
    }
    {
      const f = await fixture(); f.state.switchAccount = true;
      await assert.rejects(f.create().ensure(), /login changed/);
      assert.equal(f.calls.filter(c => c.method === 'art').length, 1);
      await assert.rejects(fs.stat(path.join(f.root, 'steam-shortcut.json')), {code: 'ENOENT'});
      passed.push('Account change stops subsequent artwork and prevents a successful receipt');
    }
    {
      const f = await fixture(); await fs.unlink(path.join(f.assets, 'wide.png'));
      await assert.rejects(f.create().ensure(), {code: 'ENOENT'}); assert.equal(f.calls.length, 0);
      passed.push('Incomplete artwork package is rejected before Steam mutation');
    }
    {
      const f = await fixture(); f.login.loginState = 0;
      const result = await f.create().status(); assert.equal(result.available, false); assert(result.warning.includes('login')); assert.equal(f.calls.length, 0);
      passed.push('Logged-out status is explicit and read-only');
    }
    {
      const f = await fixture(); delete f.apps.AddShortcut;
      await assert.rejects(f.create().ensure(), /required shortcut\/artwork APIs/);
      await assert.rejects(fs.stat(path.join(f.root, 'steam-shortcut-pending.json')), {code: 'ENOENT'});
      passed.push('Unsupported Steam API fails before creation intent or mutation');
    }
    {
      const f = await fixture(); await fs.symlink(path.join(temporary, 'unrelated'), path.join(f.root, 'steam-shortcut.json'));
      await assert.rejects(f.create().ensure(), {code: 'ELOOP'}); assert.equal(f.calls.length, 0);
      passed.push('Symlinked receipt is rejected without touching external files');
    }
    {
      const f = await fixture(); delete f.apps.SetShortcutName;
      await assert.rejects(f.create().ensure(), /required shortcut\/artwork APIs/);
      assert.equal(f.calls.length, 0);
      passed.push('New shortcut creation requires the explicit name setter before any mutation');
    }
    {
      const f = await fixture(); f.state.addUsesBasename = true; f.state.ignoreName = true; f.state.timerScale = .01;
      await assert.rejects(f.create().ensure(), /could not be verified/);
      await assert.rejects(fs.stat(path.join(f.root, 'steam-shortcut.json')), {code: 'ENOENT'});
      f.state.ignoreName = false;
      await assert.rejects(f.create().ensure(), /earlier Steam shortcut registration is incomplete/);
      assert.equal(f.calls.filter(c => c.method === 'add').length, 1);
      passed.push('Wrong new-entry display name fails readback and pending-creation recovery without adding another shortcut');
    }
    {
      const f = await fixture();
      f.add(3000000100, '"'+f.exe+'"', {visible: false, name: 'Renamed shortcut'});
      f.add(3000000101, f.exe);
      f.add(3000000102, f.exe, {local: false});
      f.add(3000000103, f.exe + '-other');
      f.add(3000000104, '/unrelated/game');
      const untouched = JSON.stringify([f.details.get(3000000102), f.details.get(3000000103), f.details.get(3000000104)]);
      const r = await f.create().remove();
      assert.deepEqual(r, {ok: true, removed: [3000000100, 3000000101], installed: false});
      assert.equal(f.map.has(3000000100), false); assert.equal(f.map.has(3000000101), false);
      assert.equal(JSON.stringify([f.details.get(3000000102), f.details.get(3000000103), f.details.get(3000000104)]), untouched);
      assert(f.calls.every(c => c.method === 'remove' && c.argumentCount === 1));
      passed.push('Uninstall removes all renamed/hidden exact local duplicates through one-argument RemoveShortcut; remote and unrelated targets remain byte-identical');
    }
    {
      const f = await fixture(); f.add(3000000110, f.exe, {local: false});
      f.map.get(3000000110).local_per_client_data = {clientid: 'remote', installed: true};
      await fs.unlink(f.exe);
      const r = await f.create().remove();
      assert.deepEqual(r, {ok: true, removed: [], installed: false}); assert.equal(f.calls.length, 0);
      assert(f.map.has(3000000110));
      passed.push('No-match removal requires live Steam but no launcher executable or artwork; nonzero client metadata is never local removal authority');
    }
    {
      const f = await fixture(); f.add(3000000111, f.exe); delete f.apps.RemoveShortcut;
      await assert.rejects(f.create().remove(), /cannot remove shortcuts/);
      assert.equal(f.calls.length, 0); assert(f.map.has(3000000111));
      passed.push('Missing removal API leaves the shortcut untouched and does not claim uninstall completion');
    }
    {
      const f = await fixture(); f.add(3000000112, f.exe);
      await assert.rejects(f.create({evaluate: async expression => {
        const result = await f.evaluate(expression);
        if (expression.includes('"action":"remove-status"')) f.login.accountName = 'different-login';
        return result;
      }}).remove(), /login changed/);
      assert.equal(f.calls.length, 0); assert(f.map.has(3000000112));
      passed.push('Account change between inventory and mutation rejects removal before any API write');
    }
    {
      const f = await fixture(); f.add(3000000113, f.exe); f.add(3000000114, f.exe); f.state.switchOnRemove = true;
      await assert.rejects(f.create().remove(), /login changed/);
      assert.equal(f.calls.filter(c => c.method === 'remove').length, 1); assert(f.map.has(3000000114));
      passed.push('Account switch during removal stops subsequent duplicate removals and prevents successful completion');
    }
    {
      const f = await fixture(); f.add(3000000115, f.exe); f.add(3000000116, f.exe); f.state.failRemove = 3000000116;
      await assert.rejects(f.create().remove(), error => {
        assert.match(error.message, /remove failure/); assert.deepEqual(Array.from(error.removed), [3000000115]); return true;
      });
      assert.equal(f.map.has(3000000115), false); assert(f.map.has(3000000116));
      assert.equal((await fs.stat(f.exe)).isFile(), true);
      passed.push('Partial duplicate removal returns confirmed removed IDs in the error and leaves installation files intact');
    }
    {
      const f = await fixture(); f.add(3000000117, f.exe); f.state.delayRemove = 25;
      const r = await f.create().remove();
      assert.equal(r.ok, true); assert.equal(f.map.has(3000000117), false);
      passed.push('Removal waits for the live client-zero overview to disappear, not merely API promise completion');
    }
    {
      const f = await fixture(); f.add(3000000118, f.exe); f.state.ignoreRemove = true; f.state.timerScale = .01;
      await assert.rejects(f.create().remove(), error => {
        assert.match(error.message, /did not confirm removal/); assert.equal(error.removed.length, 0); return true;
      });
      assert(f.map.has(3000000118));
      passed.push('An acknowledged request with unchanged live overview exhausts bounded polling and cannot report removed');
    }
    {
      const f = await fixture(); f.add(3000000119, f.exe);
      await assert.rejects(f.create({evaluate: async expression => {
        const result = await f.evaluate(expression);
        if (expression.includes('"action":"remove-status"')) f.details.get(3000000119).strShortcutExe = '/different/launcher';
        return result;
      }}).remove(), /inventory changed/);
      assert.equal(f.calls.length, 0); assert.equal(f.details.get(3000000119).strShortcutExe, '/different/launcher');
      passed.push('Target changes after inventory invalidate removal without touching the newly unrelated shortcut');
    }
    {
      const f = await fixture(); f.add(3000000120, f.exe);
      const original = f.apps.RegisterForAppDetails; let reads = 0;
      f.apps.RegisterForAppDetails = (id, callback) => {
        if (++reads === 3) f.details.get(id).strShortcutExe = '/changed/immediately-before-remove';
        return original(id, callback);
      };
      await assert.rejects(f.create().remove(), /target changed before removal/);
      assert.equal(f.calls.length, 0); assert(f.map.has(3000000120));
      passed.push('The executable is rechecked immediately before each RemoveShortcut call');
    }
    {
      const f = await fixture(); f.add(3000000121, f.exe);
      f.state.afterRemove = () => f.add(3000000122, f.exe);
      await assert.rejects(f.create().remove(), error => {
        assert.match(error.message, /remains or was added/); assert.deepEqual(Array.from(error.removed), [3000000121]); return true;
      });
      assert(f.map.has(3000000122)); assert.equal(f.calls.length, 1);
      passed.push('A new matching entry during removal causes an incomplete result instead of unapproved extra deletion');
    }
    {
      const f = await fixture();
      await assert.rejects(f.create({evaluate: async () => { throw new Error('Steam unavailable'); }}).remove(), /Steam unavailable/);
      assert.equal(f.calls.length, 0); assert.equal((await fs.stat(f.exe)).isFile(), true);
      passed.push('Disconnected Steam throws even for no known matches; no local file removal occurs');
    }
    console.log(JSON.stringify({passed, scope: 'Disposable files and VM-executed real CDP expression against mock Steam APIs; no running Steam, network, games or real shortcuts'}, null, 2));
  } finally { await fs.rm(temporary, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
