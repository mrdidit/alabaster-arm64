'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createSteamCloud, parseVDF, cacheFiles, inspectSaveFiles, logResult} = require('../src/steam-cloud.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alabaster-steam-cloud-'));
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }
// Minimal synthetic protocol fixtures, not captured account or device logs.
function completedLog(direction, buildList = false) {
  const prefix = direction === 'down' ? 'Download' : 'Upload';
  return [
    `[AppID 3110760] Starting sync (${direction},${direction === 'down' ? 'AC Launch' : 'AC Exit'},)`,
    '[AppID 3110760] AutoCloud checking local state for user 12345',
    `[AppID 3110760] ${prefix} complete${buildList ? ' in build list' : ', result OK'}`,
    '[AppID 3110760] YldWriteCacheDirectoryToFile - saved to synthetic fixture',
  ];
}
function fixture() {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const steam = path.join(home, '.local/share/Steam'), profile = path.join(home, '.config/Alabaster Dawn');
  const game = path.join(steam, 'steamapps/common/Alabaster Dawn'), saves = path.join(profile, 'Saves');
  for (const folder of [game, saves, path.join(steam, 'config'), path.join(steam, 'logs'), path.join(steam, 'userdata/12345/3110760')]) fs.mkdirSync(folder, {recursive: true});
  fs.writeFileSync(path.join(steam, 'config/loginusers.vdf'), '"users" { "76561197960278073" { "AccountName" "fixture" } }');
  const log = path.join(steam, 'logs/cloud_log.txt'); fs.writeFileSync(log, '');
  const data = Buffer.from('{"fixture":1}'), sha = crypto.createHash('sha1').update(data).digest('hex');
  fs.mkdirSync(path.join(saves, 'Default')); fs.writeFileSync(path.join(saves, 'Default/System.save'), data);
  const cache = path.join(steam, 'userdata/12345/3110760/remotecache.vdf');
  fs.writeFileSync(cache, `"3110760" { "ChangeNumber" "6" "Default/System.save" { "root" "3" "size" "${data.length}" "sha" "${sha}" "syncstate" "1" "persiststate" "0" } }`);
  let mode = 'ok', commands = 0;
  const evaluate = async expression => {
    if (expression.includes('RegisterForAppDetails')) return {accountName: 'fixture', loginState: 5, folder: game,
      compatTool: 'steamlinuxruntime', cloudEnabled: true, accountCloudEnabled: true, cloudProgress: 0};
    assert.match(expression, /loginStore\.accountName!=="fixture"/);
    if (mode === 'switched') return false;
    commands++;
    const direction = expression.includes('cloud_sync_down') ? 'down' : 'up';
    const prefix = direction === 'down' ? 'Download' : 'Upload';
    if (mode === 'timeout') return true;
    if (mode === 'dirty') fs.writeFileSync(path.join(saves, 'Default/System.save'), 'changed');
    fs.appendFileSync(log, `[AppID 3110760] Starting sync (${direction},AC Exit,)\n` +
      `[AppID 3110760] ${prefix} complete, result OK\n[AppID 3110760] YldWriteCacheDirectoryToFile - saved to fixture\n`);
    return true;
  };
  return {saves, cache, log, setMode: value => {mode = value;}, commands: () => commands,
    adapter: createSteamCloud({home, context: () => ({variant: 'full', steamProfile: profile, gameDir: game}),
      evaluate, timeout: 35, interval: 1, originalEntry: false})};
}
(async () => {
  try {
    const download = completedLog('down');
    test('synthetic completed download is accepted', () => assert.equal(logResult(download.join('\n'), 'down', '12345').done, true));
    test('synthetic completed upload is accepted', () => assert.equal(logResult(completedLog('up').join('\n'), 'up', '12345').done, true));
    test('synthetic build-list completion is accepted', () => assert.equal(logResult(completedLog('up', true).join('\n'), 'up', '12345').done, true));
    test('old success alone cannot finish', () => assert.equal(logResult('[AppID 3110760] Upload complete, result OK', 'up', '12345').done, false));
    test('partial start line waits for the next read', () => assert.equal(logResult('[AppID 3110760] Starting sync (AC Launch,', 'down', '12345').done, false));
    test('wrong direction and overlap rejected', () => {
      assert.throws(() => logResult(download.join('\n'), 'up', '12345'), /different/);
      assert.throws(() => logResult([...download, ...download].join('\n'), 'down', '12345'), /overlapped/);
    });
    test('wrong account rejected', () => assert.throws(() => logResult(download.join('\n'), 'down', '42'), /accounts/));
    test('VDF parser rejects duplicate/invalid/trailing data', () => {
      assert.equal(parseVDF('"a" { "b" "c" }').a.b, 'c');
      for (const text of ['"a" "x" "a" "y"', '"a" {', '}']) assert.throws(() => parseVDF(text));
      assert.equal(Object.getPrototypeOf(parseVDF('"__proto__" "safe"')), null);
    });
    const f = fixture();
    const blocked = createSteamCloud({home: root, context: () => null, originalEntry: true});
    assert.equal((await blocked.status()).available, false);
    assert.match((await blocked.status()).reason, /ARM64 shortcut/); checks++;
    test('Steam account marker is preserved and excluded from save hashes', () => {
      const marker = path.join(f.saves, 'steam_autocloud.vdf');
      fs.writeFileSync(marker, '"steam_autocloud.vdf" { "accountid" "12345" }');
      assert.deepEqual(Object.keys(inspectSaveFiles(f.saves, '12345')), ['Default/System.save']);
      assert.throws(() => inspectSaveFiles(f.saves, '42'), /different account/);
      fs.writeFileSync(marker, '"steam_autocloud.vdf" { "accountid" "12345" "extra" "x" }');
      assert.throws(() => inspectSaveFiles(f.saves, '12345'), /invalid/);
      fs.writeFileSync(marker, '"steam_autocloud.vdf" { "accountid" "12345" }');
    });
    test('cache and files match SHA1', () => assert.equal(cacheFiles(fs.readFileSync(f.cache, 'utf8'))['Default/System.save'].sha1, inspectSaveFiles(f.saves)['Default/System.save'].sha1));
    assert.equal((await f.adapter.status()).accountId, '12345'); checks++;
    assert.equal((await f.adapter.sync('down')).result, 'ok'); checks++;
    assert.equal((await f.adapter.sync('up')).result, 'ok'); checks++;
    f.setMode('switched'); const before = f.commands();
    await assert.rejects(f.adapter.sync('up'), error => error.quiescent === true && /account changed/.test(error.message));
    assert.equal(f.commands(), before); checks++;
    f.setMode('dirty');
    await assert.rejects(f.adapter.sync('down'), error => error.quiescent === true && /differ/.test(error.message)); checks++;
    const t = fixture(); t.setMode('timeout');
    await assert.rejects(t.adapter.sync('up'), error => error.quiescent !== true && /time/.test(error.message)); checks++;
    fs.symlinkSync('/etc/hosts', path.join(t.saves, 'Default/Save_ID_auto.save'));
    test('symlink and extra files rejected before commands', () => assert.throws(() => inspectSaveFiles(t.saves), /Unexpected/));
    console.log(JSON.stringify({checks, passed: true}));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
})().catch(error => {console.error(error); process.exitCode = 1;});
