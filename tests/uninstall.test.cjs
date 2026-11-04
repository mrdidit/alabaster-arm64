'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createUninstall} = require('../src/uninstall.cjs');
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
