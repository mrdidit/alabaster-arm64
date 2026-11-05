'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createControllerEmulation} = require('../src/controller-emulation.cjs');
const SERVICE = 'org.shadowblip.InputPlumber';
const PREFIX = '/org/shadowblip/InputPlumber';
const passed = [];

function fixture(factory=createControllerEmulation) {
  const calls=[];
  const state={configured:'ds5', deviceEnv:'ARMADA_IP_TARGETS=deck-uhid\\,xbox-series\\,xb360\\,ds5\n',
    targets:[{path:PREFIX+'/CompositeDevice0',types:['ds5','keyboard','mouse']}], active:false, apply:null, fail:null,
    sessionLoad:'loaded', sessionActive:'inactive', env:{XDG_CURRENT_DESKTOP:'KDE'}};
  function apply(value) {
    state.configured=value;
    state.targets=state.targets.map(item=>({...item,types:[value,...item.types.filter(type=>['keyboard','mouse'].includes(type))]}));
  }
  async function run(file,args,options) {
    calls.push({file,args,options});
    if(state.fail) await state.fail(file,args);
    if(file.endsWith('/systemctl')) {
      assert.deepEqual(Array.from(args),['--user','--no-pager','show','gamescope-session-plus@steam.service','--property=LoadState','--property=ActiveState']);
      return {stdout:`LoadState=${state.sessionLoad}\nActiveState=${state.sessionActive}\n`};
    }
    if(file.endsWith('/controller-type'))return {stdout:state.configured+'\n'};
    if(file.endsWith('/device-env'))return {stdout:state.deviceEnv};
    if(file.endsWith('/pkexec')) {
      assert.deepEqual(Array.from(args),['--disable-internal-agent','/usr/libexec/armada/controller-type','set',args.at(-1)]);
      if(state.apply){await state.apply(args.at(-1));return {stdout:''};}
      apply(args.at(-1));return {stdout:''};
    }
    assert.equal(file,'/usr/bin/busctl');assert.equal(args.includes(SERVICE),true);
    if(args.includes('tree'))return {stdout:state.targets.map(item=>item.path).join('\n')+'\n'};
    const object=args[5], name=args[7];
    if(name==='TargetDevices') {
      const entry=state.targets.find(item=>item.path===object);
      return {stdout:JSON.stringify({type:'as',data:entry.types.map((type,index)=>object+'/Target'+index)})};
    }
    assert.equal(name,'DeviceType');assert.equal(args[6],'org.shadowblip.Input.Target');
    const entry=state.targets.find(item=>object.startsWith(item.path+'/Target'));
    const index=Number(object.split('Target').at(-1));
    return {stdout:JSON.stringify({type:'s',data:entry.types[index]})};
  }
  return {state,calls,run,apply,api:factory({run,isBusy:()=>state.active,getEnvironment:()=>state.env}),writes:()=>calls.filter(call=>call.file.endsWith('/pkexec'))};
}
async function test(name,run){await run();passed.push(name);}
(async()=>{
  await test('Construction does not read or modify controller state; status retains current DualSense',async()=>{
    const f=fixture();assert.equal(f.calls.length,0);const value=await f.api.status();
    assert.equal(value.available,true);assert.equal(value.configured,'ds5');assert.equal(value.live,'ds5');assert.deepEqual(value.supported,['deck-uhid','xb360']);assert.equal(f.writes().length,0);
    assert.equal(value.session,'desktop');assert.equal(value.sessionSource,'systemd');assert.equal(value.sessionReason,'');
  });
  await test('Gaming Mode blocks authorization while preserving configured and live readback',async()=>{
    const f=fixture();f.state.sessionActive='active';
    const value=await f.api.status();assert.equal(value.session,'gaming');assert.equal(value.sessionSource,'systemd');
    assert.equal(value.available,false);assert.equal(value.configured,'ds5');assert.equal(value.live,'ds5');
    assert.equal(value.reason,'Use Armada Control in Gaming Mode. Switch to Desktop Mode to change this setting here.');
    await assert.rejects(f.api.set('xb360'),error=>error.state.session==='gaming'&&error.message===value.reason);
    f.apply('xb360');await assert.rejects(f.api.set('xb360'),/Use Armada Control in Gaming Mode/);
    assert.equal(f.writes().length,0);
  });
  await test('Gaming session transitions block mutation before pkexec',async()=>{
    for(const active of ['activating','reloading','deactivating']) {
      const f=fixture();f.state.sessionActive=active;
      assert.equal((await f.api.status()).session,'gaming');
      await assert.rejects(f.api.set('deck-uhid'),/Use Armada Control in Gaming Mode/);assert.equal(f.writes().length,0);
    }
  });
  await test('Authoritative Armada unit state wins over stale environment in either direction',async()=>{
    const f=fixture();f.state.env={XDG_CURRENT_DESKTOP:'gamescope',XDG_SESSION_DESKTOP:'gamescope'};
    assert.equal((await f.api.status()).session,'desktop');assert.equal((await f.api.set('xb360')).changed,true);
    const g=fixture();g.state.sessionActive='active';g.state.env={XDG_CURRENT_DESKTOP:'KDE'};
    await assert.rejects(g.api.set('xb360'),/Gaming Mode/);assert.equal(g.writes().length,0);
  });
  await test('KDE fallback ignores stale Gamescope session names and Steam Big Picture flags',async()=>{
    const f=fixture();f.state.sessionLoad='not-found';
    f.state.env={XDG_CURRENT_DESKTOP:'KDE',XDG_SESSION_DESKTOP:'gamescope',DESKTOP_SESSION:'gamescope-wayland',SteamDeck:'1',STEAM_GAMEPADUI:'1'};
    const value=await f.api.status();assert.equal(value.session,'desktop');assert.equal(value.sessionSource,'environment');
    assert.equal((await f.api.set('xb360')).changed,true);assert.equal(f.writes().length,1);
  });
  await test('Explicit Gamescope fallback blocks without a user systemd bus',async()=>{
    for(const env of [{XDG_CURRENT_DESKTOP:'gamescope'}, {XDG_CURRENT_DESKTOP:'gamescope:KDE'},
      {XDG_SESSION_DESKTOP:'gamescope'}, {DESKTOP_SESSION:'gamescope-wayland'}]) {
      const f=fixture();f.state.env=env;
      f.state.fail=file=>{if(file.endsWith('/systemctl'))throw Error('User bus unavailable');};
      const value=await f.api.status();assert.equal(value.session,'gaming');assert.equal(value.sessionSource,'environment');
      await assert.rejects(f.api.set('xb360'),/Gaming Mode/);assert.equal(f.writes().length,0);
    }
  });
  await test('Unknown sessions stay readable but cannot change controllers',async()=>{
    for(const env of [{}, {SteamDeck:'1',STEAM_GAMEPADUI:'1'}, {XDG_CURRENT_DESKTOP:'unrecognized',XDG_SESSION_DESKTOP:'plasma'}]) {
      const f=fixture();f.state.sessionLoad='not-found';f.state.env=env;
      const value=await f.api.status();assert.equal(value.session,'unknown');assert.equal(value.available,false);assert.equal(value.configured,'ds5');
      await assert.rejects(f.api.set('xb360'),/session could not be checked/);assert.equal(f.writes().length,0);
    }
  });
  await test('Session is rechecked immediately before authorization after a Desktop preflight',async()=>{
    const f=fixture();let checks=0;
    const api=createControllerEmulation({run:f.run,getEnvironment:()=>f.state.env,isBusy:()=>{
      if(++checks===2)f.state.sessionActive='active';return false;
    }});
    await assert.rejects(api.set('xb360'),error=>error.state.session==='gaming'&&/Use Armada Control/.test(error.message));
    assert.equal(f.writes().length,0);assert.equal(f.state.configured,'ds5');
  });
  await test('Returning to Desktop restores availability without automatic controller changes',async()=>{
    const f=fixture();f.state.sessionActive='active';assert.equal((await f.api.status()).available,false);
    f.state.sessionActive='inactive';assert.equal((await f.api.status()).available,true);assert.equal(f.writes().length,0);
    assert.equal((await f.api.set('xb360')).changed,true);assert.equal(f.writes().length,1);
  });
  await test('Only advertised allowed choices are exposed, including escaped device-env commas',async()=>{
    const f=fixture();f.state.deviceEnv='ARMADA_IP_TARGETS=deck-uhid\\,ds5\n';assert.deepEqual((await f.api.status()).supported,['deck-uhid']);
    await assert.rejects(f.api.set('xb360'),/not supported/);assert.equal(f.writes().length,0);
    f.state.deviceEnv="ARMADA_IP_TARGETS='xb360,ds5'\n";assert.deepEqual((await f.api.status()).supported,['xb360']);
    f.state.deviceEnv='ARMADA_IP_TARGETS=ds5\n';assert.equal((await f.api.status()).available,false);
  });
  await test('Optional device-env absence matches the existing helper fallback',async()=>{
    const f=fixture();f.state.fail=(file)=>{if(file.endsWith('device-env'))throw Object.assign(Error('missing'),{code:'ENOENT'});};
    const value=await f.api.status();assert.equal(value.available,true);assert.deepEqual(value.supported,['deck-uhid','xb360']);
  });
  await test('Actual DeviceType properties determine live type, never target path names',async()=>{
    const f=fixture();f.state.targets[0].types=['xbox-series','keyboard','mouse'];const value=await f.api.status();
    assert.equal(value.configured,'ds5');assert.equal(value.live,'xbox-series');assert.ok(f.calls.some(call=>call.args.at(-1)==='DeviceType'));
  });
  await test('Unreadable target types fail closed without a path-name guess',async()=>{
    const f=fixture();f.state.fail=(file,args)=>{if(args.at(-1)==='DeviceType')throw Error('Target property missing');};
    const value=await f.api.status();assert.equal(value.available,false);assert.equal(value.live,null);
    await assert.rejects(f.api.set('xb360'),/Target property missing/);assert.equal(f.writes().length,0);
  });
  await test('Missing helper or daemon is visibly unavailable',async()=>{
    const f=fixture();f.state.fail=(file)=>{if(file.endsWith('controller-type'))throw Object.assign(Error('missing'),{code:'ENOENT'});};
    assert.match((await f.api.status()).reason,/unavailable on this system/);
    f.state.fail=(file,args)=>{if(args.includes('tree'))throw Error('No InputPlumber service');};assert.match((await f.api.status()).reason,/No InputPlumber service/);
  });
  await test('Explicit Xbox360 switch uses bounded no-shell pkexec and verifies saved/live state',async()=>{
    const f=fixture();const value=await f.api.set('xb360');
    assert.equal(value.changed,true);assert.equal(value.configured,'xb360');assert.equal(value.live,'xb360');assert.deepEqual(value.targets[0].types,['keyboard','mouse','xb360']);
    assert.equal(f.writes().length,1);assert.equal(f.writes()[0].options.shell,false);assert.equal(f.writes()[0].options.timeout,60000);
  });
  await test('Helper processes have clean host environment without Steam loader/Python overrides',async()=>{
    const poisoned={LD_PRELOAD:'fixture-preload',LD_LIBRARY_PATH:'fixture-libraries',PYTHONHOME:'fixture-python',PYTHONPATH:'fixture-modules',VIRTUAL_ENV:'fixture-venv',BASH_ENV:'fixture-bash',ARMADA_DEVICE_DIR:'fixture-devices'};
    const old=Object.fromEntries(Object.keys(poisoned).map(key=>[key,process.env[key]]));Object.assign(process.env,poisoned);
    try {const f=fixture();await f.api.set('deck-uhid');for(const call of f.calls){for(const key of Object.keys(poisoned))assert.equal(call.options.env[key],undefined);assert.equal(call.options.env.PATH,'/usr/sbin:/usr/bin:/sbin:/bin');}}
    finally {for(const [key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
  });
  await test('Every original composite is verified; one unchanged controller is a partial failure',async()=>{
    const f=fixture();f.state.targets.push({path:PREFIX+'/CompositeDevice1',types:['deck-uhid','mouse']});
    f.state.apply=async value=>{f.state.configured=value;f.state.targets[0].types=[value,'keyboard','mouse'];};
    await assert.rejects(f.api.set('xb360'),error=>error.uncertain===true&&error.state.live==='mixed'&&/every original controller/.test(error.message));assert.equal(f.writes().length,1);
  });
  await test('Persisted mismatch and missing keyboard/mouse targets cannot report success',async()=>{
    const f=fixture();f.state.apply=async value=>{f.state.targets[0].types=[value,'keyboard','mouse'];};
    await assert.rejects(f.api.set('xb360'),error=>error.uncertain&&error.state.configured==='ds5');
    const g=fixture();g.state.apply=async value=>{g.apply(value);g.state.targets[0].types=[value,'keyboard'];};
    await assert.rejects(g.api.set('xb360'),error=>error.uncertain&&error.state.configured==='xb360');
  });
  await test('Device topology changes are not hidden by matching saved configuration',async()=>{
    const f=fixture();f.state.apply=async value=>{f.apply(value);f.state.targets.push({path:PREFIX+'/CompositeDevice1',types:[value]});};
    await assert.rejects(f.api.set('xb360'),error=>error.uncertain&&error.state.targets.length===2);
  });
  await test('No-op requires both saved and all live state to match',async()=>{
    const f=fixture();f.apply('xb360');const same=await f.api.set('xb360');assert.equal(same.changed,false);assert.equal(f.writes().length,0);
    f.state.targets[0].types=['ds5','keyboard','mouse'];assert.equal((await f.api.set('xb360')).changed,true);assert.equal(f.writes().length,1);
  });
  await test('Only Steam Deck and Xbox360 can be applied',async()=>{
    const f=fixture();for(const value of ['ds5','xbox-series','xb360;anything','',null])await assert.rejects(f.api.set(value),/Choose Steam Deck or Xbox 360/);assert.equal(f.calls.length,0);
  });
  await test('An active game prevents changing emulation',async()=>{
    const f=fixture();f.state.active=true;await assert.rejects(f.api.set('xb360'),/Close the game/);assert.equal(f.writes().length,0);
  });
  await test('Authentication cancellation and missing agent refresh state without claiming application',async()=>{
    for(const code of [126,127]){const f=fixture();f.state.apply=async()=>{throw Object.assign(Error('authorization failed'),{code});};
      await assert.rejects(f.api.set('xb360'),error=>!error.uncertain&&error.state.configured==='ds5'&&/authentication agent/.test(error.message));assert.equal(f.writes().length,1);}
  });
  await test('A helper error after a partial change is returned with current state',async()=>{
    const f=fixture();f.state.apply=async value=>{f.state.targets[0].types=[value,'keyboard','mouse'];throw Object.assign(Error('helper failed'),{code:1});};
    await assert.rejects(f.api.set('xb360'),error=>error.uncertain&&error.state.configured==='ds5'&&error.state.live==='xb360');
  });
  await test('Post-switch readback failure is explicit and uncertain',async()=>{
    const f=fixture();f.state.apply=async value=>{f.apply(value);f.state.fail=(_file,args)=>{if(args.at(-1)==='DeviceType')throw Error('readback unavailable');};};
    await assert.rejects(f.api.set('xb360'),error=>error.uncertain&&!error.state.available&&/readback unavailable/.test(error.message));
  });
  await test('Concurrent setters are excluded from the start of preflight',async()=>{
    const f=fixture();let resolve;const original=f.run;
    const api=createControllerEmulation({run:async(file,args,options)=>{if(file.endsWith('controller-type'))await new Promise(done=>{resolve=done;});return original(file,args,options);}});
    const pending=api.set('xb360');await assert.rejects(api.set('deck-uhid'),/already running/);
    while(!resolve)await new Promise(done=>setImmediate(done));resolve();
    await new Promise(done=>setImmediate(done));resolve();assert.equal((await pending).changed,true);assert.equal(f.writes().length,1);
  });
  await test('Independent timeout survives EPERM, blocks retry until actual child exit, and permits status reads',async()=>{
    const f=fixture();let elevated=null, attempts=0;
    const stub=(file,args,options,callback)=>{
      const child=new EventEmitter();child.pid=999990+attempts;child.stdin={end(){}};
      child.kill=()=>{const error=Object.assign(Error('kill EPERM'),{code:'EPERM'});child.emit('error',error);callback(error,'','');return false;};
      if(file.endsWith('/pkexec')&&attempts++===0){elevated=child;return child;}
      f.run(file,args,options).then(value=>{child.emit('exit',0);callback(null,value.stdout||'','');},error=>{child.emit('exit',error.code||1);callback(error,'','');});
      return child;
    };
    const context={module:{exports:{}},require:name=>{assert.equal(name,'node:child_process');return {execFile:stub};},process,setTimeout,clearTimeout};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/controller-emulation.cjs'),'utf8'),context);
    const api=context.module.exports.createControllerEmulation({applyTimeoutMs:15,readTimeoutMs:500});
    await assert.rejects(api.set('xb360'),error=>error.uncertain&&/timed out/.test(error.message));
    assert.ok(elevated);assert.equal((await api.status()).configured,'ds5');assert.equal((await api.status()).available,false);
    await assert.rejects(api.set('deck-uhid'),/may still be running/);assert.equal(attempts,1);
    elevated.emit('exit',0);await Promise.resolve();
    assert.equal((await api.status()).available,true);assert.equal((await api.set('xb360')).changed,true);assert.equal(attempts,2);
  });
  await test('Unknown privileged lifetime keeps a conservative retry latch',async()=>{
    const f=fixture();f.state.apply=async()=>{throw Object.assign(Error('kill EPERM'),{code:'EPERM'});};
    await assert.rejects(f.api.set('xb360'),error=>error.uncertain);await assert.rejects(f.api.set('deck-uhid'),/may still be running/);assert.equal(f.writes().length,1);
  });
  console.log(JSON.stringify({passed,scope:'Mock helper, D-Bus and child-process fixtures only; no live controller, authorization or system changes.'},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
