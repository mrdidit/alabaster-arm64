'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createUninstall} = require('../src/uninstall.cjs');
const {createSetup} = require('../src/setup.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alabaster-uninstall-test-'));
const passed = [];
const originalEnvironment = {XDG_DATA_HOME:process.env.XDG_DATA_HOME, XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME};
const runtimeName = 'nwjs-v0.119.2-linux-arm64';
function put(file, data) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file,data); }
function entry(executable, extra='') {
  const command = '"'+executable.replace(/[%\\"`$]/g, char=>char==='%'?'%%':'\\'+char)+'"';
  return '[Desktop Entry]\nType=Application\nName=Alabaster Dawn ARM64\nExec='+command.replace(/\\/g,'\\\\')+'\n'+extra;
}
function fixture(name) {
  const base=path.join(temp,name), home=path.join(base,'home'), root=path.join(home,'Native Launcher');
  const original=path.join(home,'Steam game'), data=path.join(home,'.local/share'), desktop=path.join(home,'Desktop');
  fs.mkdirSync(root,{recursive:true});fs.mkdirSync(desktop,{recursive:true});fs.mkdirSync(path.join(data,'applications'),{recursive:true});
  process.env.XDG_DATA_HOME=data;process.env.XDG_CONFIG_HOME=path.join(home,'.config');
  const header=Buffer.alloc(20);Buffer.from([0x7f,0x45,0x4c,0x46,2,1]).copy(header);header.writeUInt16LE(183,18);
  put(path.join(root,'alabaster-dawn.arm64'),header);
  for(const file of ['launcher.c','setup.cjs','save-transfer.cjs','cloud-sync.cjs','steam-cloud.cjs','steam-shortcut.cjs','uninstall.cjs'])put(path.join(root,file),'fixture '+file);
  put(path.join(root,'app/package.json'),JSON.stringify({name:'Alabaster Dawn ARM64',main:'menu/index.html'}));
  put(path.join(root,'app/menu/index.html'),'menu');put(path.join(root,'menu/index.html'),'menu');
  put(path.join(root,'app/menu/window.js'),'window lifecycle');put(path.join(root,'menu/window.js'),'window lifecycle');
  put(path.join(root,'app/menu/assets/THIRD_PARTY.txt'),'bundled notices');put(path.join(root,'menu/assets/THIRD_PARTY.txt'),'bundled notices');
  put(path.join(root,'menu/assets/fonts/LICENSE.txt'),'license');put(path.join(root,'app/menu/assets/steam/logo.png'),'image');
  put(path.join(original,'terra/dist/bundle.js'),'original game');
  put(path.join(root,'app/terra/index.html'),'bound page');fs.symlinkSync(path.join(original,'terra/dist'),path.join(root,'app/terra/dist'));
  put(path.join(root,'runtime',runtimeName,'nw'),'runtime');put(path.join(root,'runtime',runtimeName,'locales/en-US.pak'),'locale');
  put(path.join(root,'profile/Saves/Default/System.save'),'saved progress');
  put(path.join(root,'profile-edition.json'),'{"schema":1,"variant":"full"}');
  put(path.join(root,'save-backups/one.save'),'local backup');put(path.join(root,'cloud-backups/one.save'),'cloud backup');
  put(path.join(root,'cloud-recovery.json'),'recovery');put(path.join(root,'logs/capture.log'),'diagnostic');
  put(path.join(root,'unrelated/notes.txt'),'keep');put(path.join(root,'runtime/another-runtime/nw'),'other runtime');
  const executable=path.join(root,'alabaster-dawn.arm64');
  const applications=path.join(data,'applications');
  const applicationEntry=path.join(applications,'alabaster-dawn-arm64.desktop'), desktopEntry=path.join(desktop,'Alabaster-Dawn-ARM64.desktop');
  put(applicationEntry,entry(executable,'X-Alabaster-ARM64-Managed=true\n'));put(desktopEntry,entry(executable));
  let active=false, calls=0;
  const callbacks={remove:async()=>({ok:true,removed:[3160928690],installed:false})};
  const api=createUninstall({root,home,isBusy:async()=>active,removeSteamShortcut:async()=>{calls++;return callbacks.remove();}});
  return {root,home,original,desktop,applications,applicationEntry,desktopEntry,executable,api,callbacks,calls:()=>calls,setBusy:value=>{active=value;}};
}
function preserved(f) {
  assert.equal(fs.readFileSync(path.join(f.original,'terra/dist/bundle.js'),'utf8'),'original game');
  assert.equal(fs.readFileSync(path.join(f.root,'profile/Saves/Default/System.save'),'utf8'),'saved progress');
  assert.equal(fs.readFileSync(path.join(f.root,'save-backups/one.save'),'utf8'),'local backup');
  assert.equal(fs.readFileSync(path.join(f.root,'cloud-backups/one.save'),'utf8'),'cloud backup');
  assert.equal(fs.readFileSync(path.join(f.root,'cloud-recovery.json'),'utf8'),'recovery');
  assert.ok(fs.existsSync(path.join(f.root,'profile-edition.json')));
  assert.equal(fs.readFileSync(path.join(f.root,'unrelated/notes.txt'),'utf8'),'keep');
  assert.equal(fs.readFileSync(path.join(f.root,'runtime/another-runtime/nw'),'utf8'),'other runtime');
}
async function test(name, run) { await run();passed.push(name); }
(async()=>{
  try {
    await test('Preview is read-only and names only managed paths',async()=>{
      const f=fixture('preview'), result=await f.api.preview();
      assert.equal(f.calls(),0);assert.ok(result.bytes>0);assert.ok(result.removePaths.includes(f.executable));
      assert.ok(result.preservedPaths.includes(path.join(f.root,'profile')));assert.ok(fs.existsSync(f.applicationEntry));preserved(f);
    });
    await test('Complete uninstall removes this application/runtime and both exact desktop entries while retaining game, saves and unrelated files',async()=>{
      const f=fixture('complete');
      f.callbacks.remove=async()=>{assert.ok(fs.existsSync(f.executable));assert.ok(fs.existsSync(f.applicationEntry));return {ok:true,removed:[3160928690]};};
      const result=await f.api.uninstall();assert.equal(result.ok,true);assert.equal(result.removed,true);assert.equal(f.calls(),1);
      assert.equal(fs.existsSync(f.executable),false);assert.equal(fs.existsSync(path.join(f.root,'app')),false);
      assert.equal(fs.existsSync(path.join(f.root,'menu')),false);assert.equal(fs.existsSync(path.join(f.root,'runtime',runtimeName)),false);
      assert.equal(fs.existsSync(f.applicationEntry),false);assert.equal(fs.existsSync(f.desktopEntry),false);preserved(f);
    });
    await test('A real setup binding with file and directory links uninstalls without Disconnect',async()=>{
      const f=fixture('setup-connected');
      put(path.join(f.original,'package.json'),JSON.stringify({name:'Alabaster Dawn',main:'terra/index.html'}));
      put(path.join(f.original,'terra/index.html'),'<html>original entry</html>');
      put(path.join(f.original,'terra/style.css'),'original style');put(path.join(f.original,'terra/data/content.json'),'original data');
      fs.chmodSync(path.join(f.root,'runtime',runtimeName,'nw'),0o700);
      const setup=createSetup({root:f.root,home:f.home,nativeDataPath:path.join(f.root,'profile/Default')});
      assert.equal((await setup.install(f.original)).installed,true);
      assert.equal(setup.getContext().gameDir,f.original);
      assert.ok(fs.lstatSync(path.join(f.root,'app/terra/style.css')).isSymbolicLink());
      assert.ok(fs.lstatSync(path.join(f.root,'app/terra/data')).isSymbolicLink());
      const plan=await f.api.preview();
      assert.ok(plan.removePaths.includes(path.join(f.root,'setup.json')));
      assert.ok(plan.removePaths.includes(path.join(f.root,'app/menu/window.js')));
      assert.equal((await f.api.uninstall()).ok,true);
      assert.equal(fs.existsSync(path.join(f.root,'app')),false);assert.equal(fs.existsSync(path.join(f.root,'setup.json')),false);
      assert.equal(fs.readFileSync(path.join(f.original,'terra/index.html'),'utf8'),'<html>original entry</html>');
      assert.equal(fs.readFileSync(path.join(f.original,'terra/style.css'),'utf8'),'original style');
      assert.equal(fs.readFileSync(path.join(f.original,'terra/data/content.json'),'utf8'),'original data');preserved(f);
    });
    await test('Both bundled attribution copies are removed without removing original or unrelated attribution files',async()=>{
      const f=fixture('bundled-notices');
      const originalNotice=path.join(f.original,'terra/THIRD_PARTY.txt'), customNotice=path.join(f.root,'unrelated/THIRD_PARTY.txt');
      put(originalNotice,'original game notices');put(customNotice,'unrelated notices');
      const removed=[path.join(f.root,'app/menu/assets/THIRD_PARTY.txt'),path.join(f.root,'menu/assets/THIRD_PARTY.txt')];
      const preview=await f.api.preview();for(const file of removed)assert.ok(preview.removePaths.includes(file));
      const result=await f.api.uninstall();for(const file of removed){assert.ok(result.removedPaths.includes(file));assert.equal(fs.existsSync(file),false);}
      assert.equal(fs.readFileSync(originalNotice,'utf8'),'original game notices');assert.equal(fs.readFileSync(customNotice,'utf8'),'unrelated notices');preserved(f);
    });
    await test('Disconnected source storage does not require resolving dangling binding links',async()=>{
      const f=fixture('dangling-source');put(path.join(f.root,'setup.json'),JSON.stringify({schema:1,gamePath:f.original}));
      fs.renameSync(f.original,f.original+'-moved');
      assert.equal((await f.api.uninstall()).ok,true);assert.equal(fs.existsSync(path.join(f.root,'app')),false);
      assert.equal(fs.readFileSync(path.join(f.original+'-moved','terra/dist/bundle.js'),'utf8'),'original game');
      assert.equal(fs.readFileSync(path.join(f.root,'profile/Saves/Default/System.save'),'utf8'),'saved progress');
    });
    await test('A top-level game binding symlink is unlinked without traversing original files',async()=>{
      const f=fixture('linked-binding');fs.rmSync(path.join(f.root,'app/terra'),{recursive:true});
      fs.symlinkSync(path.join(f.original,'terra'),path.join(f.root,'app/terra'));
      assert.equal((await f.api.uninstall()).ok,true);assert.equal(fs.existsSync(path.join(f.root,'app')),false);preserved(f);
    });
    await test('Steam failure prevents every local deletion',async()=>{
      const f=fixture('steam-failure');f.callbacks.remove=async()=>{throw Error('Steam is offline');};
      await assert.rejects(f.api.uninstall(),/Steam is offline/);assert.ok(fs.existsSync(f.executable));assert.ok(fs.existsSync(f.desktopEntry));preserved(f);
      f.callbacks.remove=async()=>({ok:false,warning:'Steam entry could not be removed'});
      await assert.rejects(f.api.uninstall(),/Steam entry could not be removed/);assert.ok(fs.existsSync(f.executable));
    });
    await test('Missing Steam-removal capability fails before local removal',async()=>{
      const f=fixture('no-steam-api'), api=createUninstall({root:f.root,home:f.home});
      await assert.rejects(api.uninstall(),/removal is unavailable/);assert.ok(fs.existsSync(f.executable));preserved(f);
    });
    await test('Running game blocks preview and uninstall before Steam operations',async()=>{
      const f=fixture('busy');f.setBusy(true);await assert.rejects(f.api.preview(),/Close both versions/);await assert.rejects(f.api.uninstall(),/Close both versions/);assert.equal(f.calls(),0);preserved(f);
    });
    await test('Shared runtime, game and module symlink targets survive',async()=>{
      const f=fixture('shared');const shared=path.join(f.home,'shared-runtime');put(path.join(shared,'nw'),'shared runtime');
      fs.rmSync(path.join(f.root,'runtime',runtimeName),{recursive:true});fs.symlinkSync(shared,path.join(f.root,'runtime',runtimeName));
      const external=path.join(f.home,'shared-module.cjs');put(external,'shared module');fs.unlinkSync(path.join(f.root,'setup.cjs'));fs.symlinkSync(external,path.join(f.root,'setup.cjs'));
      await f.api.uninstall();assert.equal(fs.readFileSync(path.join(shared,'nw'),'utf8'),'shared runtime');assert.equal(fs.readFileSync(external,'utf8'),'shared module');preserved(f);
    });
    await test('Unrelated, linked and ambiguous shortcuts are retained',async()=>{
      const f=fixture('foreign-shortcuts');const unrelated=path.join(f.applications,'other.desktop'), ambiguous=path.join(f.desktop,'ambiguous.desktop');
      put(unrelated,entry(path.join(f.home,'Different root/alabaster-dawn.arm64')));put(ambiguous,'[Desktop Entry]\nExec=env SPECIAL=1 "'+f.executable+'"\n');
      const alias=path.join(f.desktop,'Alabaster-linked.desktop');fs.symlinkSync(unrelated,alias);
      const result=await f.api.uninstall();assert.ok(fs.existsSync(unrelated));assert.ok(fs.existsSync(ambiguous));assert.ok(fs.lstatSync(alias).isSymbolicLink());
      assert.ok(result.warnings.some(warning=>warning.includes('ambiguous')));assert.ok(result.warnings.some(warning=>warning.includes('linked')));
    });
    await test('Exact historical full and Test shortcuts are removed while every legacy installation file is retained',async()=>{
      const f=fixture('legacy-shortcuts'), full=path.join(f.home,'Games/Alabaster-Dawn-ARM64'), demo=path.join(f.home,'Games/Alabaster-Dawn-ARM64-Test');
      for(const old of [full,demo]) {put(path.join(old,'alabaster-dawn.arm64'),'legacy executable');put(path.join(old,'profile/Saves/Default/System.save'),'legacy save');put(path.join(old,'runtime/nw'),'legacy runtime');}
      put(path.join(demo,'launch.sh'),'legacy shell');
      const paths=[path.join(f.desktop,'Old full.desktop'),path.join(f.applications,'Alabaster-Dawn-ARM64-Test.desktop'),path.join(f.desktop,'Alabaster-Dawn-ARM64-Test.desktop')];
      put(paths[0],entry(path.join(full,'alabaster-dawn.arm64')));
      put(paths[1],entry(path.join(demo,'alabaster-dawn.arm64')).replace('Name=Alabaster Dawn ARM64\n','Name=Alabaster Dawn ARM64 Test\n'));
      put(paths[2],entry(path.join(demo,'launch.sh')).replace('Name=Alabaster Dawn ARM64\n','Name=Alabaster Dawn ARM64 Test\n'));
      const result=await f.api.uninstall();for(const file of paths)assert.ok(result.removedPaths.includes(file));
      for(const old of [full,demo]) {assert.equal(fs.readFileSync(path.join(old,'alabaster-dawn.arm64'),'utf8'),'legacy executable');assert.equal(fs.readFileSync(path.join(old,'profile/Saves/Default/System.save'),'utf8'),'legacy save');assert.equal(fs.readFileSync(path.join(old,'runtime/nw'),'utf8'),'legacy runtime');}
      assert.equal(fs.readFileSync(path.join(demo,'launch.sh'),'utf8'),'legacy shell');preserved(f);
    });
    await test('Known historical shortcuts are removed even after their launcher roots disappeared',async()=>{
      const f=fixture('legacy-missing'), old=path.join(f.home,'Games/Alabaster-Dawn-ARM64/alabaster-dawn.arm64');
      const shortcut=path.join(f.desktop,'Old full.desktop');put(shortcut,entry(old));
      const result=await f.api.uninstall();assert.ok(result.removedPaths.includes(shortcut));assert.equal(fs.existsSync(path.join(f.home,'Games')),false);preserved(f);
    });
    await test('Legacy cleanup refuses names alone, custom commands, duplicate identities and symlinked targets',async()=>{
      const f=fixture('legacy-reject'), full=path.join(f.home,'Games/Alabaster-Dawn-ARM64'), demo=path.join(f.home,'Games/Alabaster-Dawn-ARM64-Test');
      const other=path.join(f.home,'Other application');put(path.join(other,'alabaster-dawn.arm64'),'unrelated executable');
      fs.mkdirSync(path.dirname(full),{recursive:true});fs.symlinkSync(other,full);
      fs.mkdirSync(demo);fs.symlinkSync(path.join(other,'alabaster-dawn.arm64'),path.join(demo,'alabaster-dawn.arm64'));
      const sources=[entry(path.join(full,'alabaster-dawn.arm64')),entry(path.join(demo,'alabaster-dawn.arm64')).replace('Name=Alabaster Dawn ARM64\n','Name=Alabaster Dawn ARM64 Test\n'),
        entry(path.join(f.home,'Different root/alabaster-dawn.arm64')),entry(path.join(f.home,'Games/Alabaster-Dawn-ARM64-Other/alabaster-dawn.arm64')),
        entry(path.join(demo,'launch.sh')),entry(path.join(demo,'launch.sh')).replace('Type=Application','Type=Link'),
        entry(path.join(demo,'launch.sh'))+'Name=Alabaster Dawn ARM64 Test\n',
        '[Desktop Entry]\nType=Application\nName=Alabaster Dawn ARM64 Test\nExec="'+path.join(demo,'launch.sh')+'" --custom\n'];
      const files=sources.map((source,index)=>{const file=path.join(f.desktop,'keep-'+index+'.desktop');put(file,source);return file;});
      await f.api.uninstall();for(const file of files)assert.ok(fs.existsSync(file));
      assert.equal(fs.readFileSync(path.join(other,'alabaster-dawn.arm64'),'utf8'),'unrelated executable');preserved(f);
    });
    await test('Unknown content inside managed containers is preserved and disclosed',async()=>{
      const f=fixture('unknown-content');put(path.join(f.root,'menu/custom/readme.txt'),'custom menu');put(path.join(f.root,'app/terra/custom.txt'),'custom game');
      const plan=await f.api.preview();assert.ok(plan.preservedPaths.includes(path.join(f.root,'menu/custom')));
      const result=await f.api.uninstall();assert.equal(fs.readFileSync(path.join(f.root,'menu/custom/readme.txt'),'utf8'),'custom menu');assert.equal(fs.readFileSync(path.join(f.root,'app/terra/custom.txt'),'utf8'),'custom game');assert.ok(result.warnings.length);preserved(f);
    });
    await test('Home, linked root and unrecognized occupied directories are refused',async()=>{
      const f=fixture('wrong-root');assert.throws(()=>createUninstall({root:f.home,home:f.home}),/home directory/);
      const alias=path.join(f.home,'alias');fs.symlinkSync(f.root,alias);assert.throws(()=>createUninstall({root:alias,home:f.home}),/symbolic link/);
      put(path.join(f.root,'app/package.json'),JSON.stringify({name:'Some other app',main:'menu/index.html'}));
      await assert.rejects(f.api.uninstall(),/recognized ARM64/);assert.equal(f.calls(),0);assert.ok(fs.existsSync(f.executable));
    });
    await test('Linked managed parent and unexpected file type fail before Steam removal',async()=>{
      const f=fixture('linked-parent');fs.renameSync(path.join(f.root,'app'),path.join(f.home,'app-external'));fs.symlinkSync(path.join(f.home,'app-external'),path.join(f.root,'app'));
      await assert.rejects(f.api.uninstall(),/managed parent is linked/);assert.equal(f.calls(),0);assert.ok(fs.existsSync(f.executable));
      const g=fixture('wrong-type');fs.unlinkSync(path.join(g.root,'setup.cjs'));fs.mkdirSync(path.join(g.root,'setup.cjs'));
      await assert.rejects(g.api.uninstall(),/Expected a managed file/);assert.equal(g.calls(),0);
    });
    await test('Changed files after Steam removal stop local uninstall',async()=>{
      const f=fixture('changed');f.callbacks.remove=async()=>{fs.appendFileSync(path.join(f.root,'setup.cjs'),' concurrent update');return {ok:true,removed:[]};};
      await assert.rejects(f.api.uninstall(),/changed during Steam removal/);assert.ok(fs.existsSync(f.executable));assert.ok(fs.existsSync(f.applicationEntry));preserved(f);
    });
    await test('An installation or previous uninstall staging directory blocks removal',async()=>{
      const f=fixture('staging');fs.mkdirSync(path.join(f.root,'.setup-in-progress'));
      await assert.rejects(f.api.uninstall(),/installation staging/);assert.equal(f.calls(),0);fs.rmdirSync(path.join(f.root,'.setup-in-progress'));
      fs.mkdirSync(path.join(f.root,'.uninstall-recovery'));await assert.rejects(f.api.uninstall(),/previous uninstall staging/);assert.equal(f.calls(),0);preserved(f);
    });
    await test('Replacing the installation directory after creating the API is refused',async()=>{
      const f=fixture('replaced-root');fs.renameSync(f.root,f.root+'-original');fs.cpSync(f.root+'-original',f.root,{recursive:true});
      await assert.rejects(f.api.uninstall(),/installation directory changed/);assert.equal(f.calls(),0);assert.ok(fs.existsSync(f.executable));
    });
    await test('Staging failure restores previously moved local files',async()=>{
      const f=fixture('rollback'), rename=fs.renameSync;let count=0;
      fs.renameSync=(source,destination)=>{if(source.startsWith(f.root)&&!source.includes('/.uninstall-')&&++count===2)throw Error('injected staging failure');return rename(source,destination);};
      try { await assert.rejects(f.api.uninstall(),/injected staging failure/); } finally { fs.renameSync=rename; }
      assert.ok(fs.existsSync(f.executable));assert.ok(fs.existsSync(path.join(f.root,'launcher.c')));assert.ok(fs.existsSync(f.applicationEntry));preserved(f);
      assert.equal(fs.readdirSync(f.root).some(name=>name.startsWith('.uninstall-')),false);
    });
    await test('A failure after moving a connected binding restores its index and symlink together',async()=>{
      const f=fixture('binding-rollback'), rename=fs.renameSync;
      fs.renameSync=(source,destination)=>{if(source===path.join(f.root,'runtime',runtimeName))throw Error('injected post-binding failure');return rename(source,destination);};
      try {await assert.rejects(f.api.uninstall(),/injected post-binding failure/);} finally {fs.renameSync=rename;}
      assert.equal(fs.readFileSync(path.join(f.root,'app/terra/index.html'),'utf8'),'bound page');
      assert.equal(fs.readlinkSync(path.join(f.root,'app/terra/dist')),path.join(f.original,'terra/dist'));
      assert.equal(fs.readdirSync(f.root).some(name=>name.startsWith('.uninstall-')),false);preserved(f);
    });
    await test('Deletion failure is explicitly partial and retains recovery paths',async()=>{
      const f=fixture('partial'), remove=fs.rmSync;let count=0;
      fs.rmSync=(file,options)=>{if(file.includes('/.uninstall-')&&++count===2)throw Error('injected delete failure');return remove(file,options);};
      let error;
      try { await f.api.uninstall(); } catch(value) {error=value;} finally {fs.rmSync=remove;}
      assert.equal(error.partial,true);assert.match(error.message,/did not complete/);assert.ok(error.removedPaths.includes(f.executable));assert.ok(error.recoveryPaths.length>0);assert.ok(error.recoveryPaths.every(file=>fs.existsSync(file)));preserved(f);
    });
    await test('Concurrent uninstall is refused while Steam removal is pending',async()=>{
      const f=fixture('exclusive');let finish;f.callbacks.remove=()=>new Promise(resolve=>{finish=resolve;});
      const pending=f.api.uninstall();while(!finish)await new Promise(resolve=>setImmediate(resolve));
      await assert.rejects(f.api.uninstall(),/already running/);finish({ok:true,removed:[]});assert.equal((await pending).ok,true);
    });
    await test('XDG custom Desktop is respected and a disabled HOME Desktop is not scanned',async()=>{
      const f=fixture('xdg');const custom=path.join(f.home,'Custom Desktop');put(path.join(custom,'Any name.desktop'),entry(f.executable));
      put(path.join(f.home,'.config/user-dirs.dirs'),'XDG_DESKTOP_DIR="$HOME/Custom Desktop"\n');
      await f.api.uninstall();assert.equal(fs.existsSync(path.join(custom,'Any name.desktop')),false);assert.ok(fs.existsSync(f.desktopEntry));
      const g=fixture('disabled-desktop');put(path.join(g.home,'.config/user-dirs.dirs'),'XDG_DESKTOP_DIR="$HOME"\n');put(path.join(g.home,'Personal.desktop'),entry(g.executable));
      await g.api.uninstall();assert.ok(fs.existsSync(path.join(g.home,'Personal.desktop')));
    });
  } finally {
    for(const [key,value]of Object.entries(originalEnvironment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(temp,{recursive:true,force:true});
  }
  console.log(JSON.stringify({passed,scope:'Temporary local fixtures; mocked Steam removal; no live application, profile or Steam changes.'},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
