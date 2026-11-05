'use strict';
// Real menu, mocked backend, private display. No game, Steam or system changes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn,execFile} = require('node:child_process');
const {promisify} = require('node:util');
const executeFile = promisify(execFile);

const root = path.resolve(__dirname, '..');
const runtime = process.argv[2] || process.env.NW_RUNTIME;
if (!runtime) throw Error('Usage: node tests/options-ui.cjs /path/to/nwjs-sdk/nw');
const menuOnly=process.env.ALABASTER_UI_MENU_ONLY==='1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await wait(80); }
  throw Error('Bounded UI wait expired');
}
function child(command, args, env, extra = false) {
  const p = spawn(command, args, {env, detached:true, stdio:['ignore','ignore','pipe',...(extra?['pipe']:[])]});
  p.diagnostic = ''; p.stderr.on('data', data => {p.diagnostic=(p.diagnostic+data).slice(-4000);});
  return p;
}
async function stop(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  try { process.kill(-p.pid, 'SIGTERM'); } catch (error) { if (error.code!=='ESRCH') throw error; }
  for (let i=0;i<30&&p.exitCode===null&&p.signalCode===null;i++) await wait(100);
  if (p.exitCode===null&&p.signalCode===null) try { process.kill(-p.pid, 'SIGKILL'); } catch(error) { if(error.code!=='ESRCH') throw error; }
}
async function port() {
  const server=net.createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const value=server.address().port; await new Promise(resolve=>server.close(resolve)); return value;
}

const fixture = `
window.fixture={controllerReads:0,controllerWrites:[],hudReads:0,hudWrites:[],hudError:'',
 bound:true,setupReads:0,disconnectCalls:0,uninstallPreviews:0,completeUninstallCalls:0,uninstallPreviewError:'',completeUninstallError:'',
 controller:{available:true,configured:'ds5',live:'ds5',supported:['deck-uhid','xb360'],targets:[],busy:false},
 hud:{ok:true,available:true,installed:true,supported:true,enabled:false,reason:'',appId:123,launchOptions:'/usr/libexec/armada/armada-game-launch %command%',manualLaunchOptions:'MANGOHUD_CONFIGFILE=/dev/null MANGOHUD_CONFIG=preset=2,no_display=0,position=bottom-right,font_size=18 mangohud /usr/libexec/armada/armada-game-launch %command%',token:'fixture-token'}};
window.launcherAPI={
 browseGame:async()=>{throw Error('Unexpected fixture browseGame call')},
 install:async()=>{throw Error('Unexpected fixture install call')},
 uninstall:async()=>{fixture.disconnectCalls++;fixture.bound=false;return {installed:false}},
 completeUninstall:async()=>{fixture.completeUninstallCalls++;if(fixture.completeUninstallError)throw Error(fixture.completeUninstallError);throw Error('Unexpected successful fixture removal request')},
 preview:async()=>{throw Error('Unexpected fixture save preview call')},
 sync:async()=>{throw Error('Unexpected fixture save sync call')},
 setupStatus:async()=>{fixture.setupReads++;return {installed:fixture.bound,gamePath:fixture.bound?'/fixture/game':'',defaultGamePath:'/fixture/game',edition:'full'}},
 finishSetup:async()=>({skipped:true}),
 status:async()=>({steam:{count:0,slots:[],autosave:{available:false}},arm64:{count:0,slots:[],autosave:{available:false}},busy:false}),
 addToSteam:async()=>({ok:true}),
 uninstallPreview:async()=>{fixture.uninstallPreviews++;if(fixture.uninstallPreviewError)throw Error(fixture.uninstallPreviewError);return {root:'/fixture',removePaths:['/fixture/app/terra/index.html'],preservedPaths:['/fixture/profile','/fixture/game'],warnings:[],bytes:0}},
 controllerStatus:async()=>{fixture.controllerReads++;return structuredClone(fixture.controller)},
 controllerSet:async type=>{fixture.controllerWrites.push(type);fixture.controller.configured=fixture.controller.live=type;return structuredClone(fixture.controller)},
 hudStatus:async()=>{fixture.hudReads++;return structuredClone(fixture.hud)},
 hudSet:async(enabled,options)=>{fixture.hudWrites.push({enabled,options});if(fixture.hudError)throw Error(fixture.hudError);fixture.hud.enabled=enabled;fixture.hud.launchOptions=enabled?fixture.hud.manualLaunchOptions:'/usr/libexec/armada/armada-game-launch %command%';fixture.hud.token+='-next';return structuredClone(fixture.hud)},
 play:async()=>{},exit:async()=>{}
};`;

(async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'alabaster-options-ui-'));
  const screenshots=await fs.mkdtemp(path.join(os.tmpdir(),'alabaster-options-screens-'));
  const passed=[]; let xvfb,windowManager,nw,ws;
  let windowEvidence=null;
  const windowProbes=[];
  const overall=setTimeout(()=>{console.error('Options UI exceeded 70 seconds');void stop(nw).then(()=>stop(windowManager)).then(()=>stop(xvfb)).finally(()=>process.exit(1));},70000);
  try {
    const productionManifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
    assert.notEqual(productionManifest.window?.fullscreen,true,'The menu keeps normal window mode');
    assert.notEqual(productionManifest.window?.frame,false,'The menu keeps window decorations');
    passed.push('Production NW manifest keeps a normal decorated window');
    await fs.cp(path.join(root,'src/menu'),path.join(temp,'menu'),{recursive:true});
    const page=path.join(temp,'menu/index.html');
    const html=await fs.readFile(page,'utf8');
    assert.ok(/<script\b[^>]*\bsrc=["']window\.js["'][^>]*>/.test(html),'The real page loads its window helper');
    assert.ok(html.indexOf('src="window.js"')<html.indexOf('src="backend.js"'),'Window helper loads before the backend');
    const earlyErrors='<script>window.fixtureStartupErrors=[];window.fixtureConsoleErrors=[];const originalError=console.error.bind(console);console.error=(...args)=>{window.fixtureConsoleErrors.push(args.map(String).join(" ").slice(0,700));originalError(...args);};window.addEventListener("error",e=>{window.fixtureStartupErrors.push({message:String(e.message).slice(0,500),file:e.filename,line:e.lineno});});</script>';
    await fs.writeFile(page,html.replace('<script src="window.js" defer></script>',earlyErrors+'<script src="window.js" defer></script>')
      .replace('<script src="backend.js" defer></script>','<script src="fixture.js" defer></script>'));
    await fs.writeFile(path.join(temp,'menu/fixture.js'),fixture);
    // Existing installations retain app/package.json. Intentionally preserve an
    // old windowed manifest so only the real startup helper can maximize it.
    const legacyManifest={...productionManifest,name:'alabaster-options-fixture',
      window:{...productionManifest.window,title:'Alabaster Options Fixture',fullscreen:false}};
    // Game icons are not part of this disposable, game-free menu fixture.
    delete legacyManifest.window.icon;delete legacyManifest.icons;
    await fs.writeFile(path.join(temp,'package.json'),JSON.stringify(legacyManifest));
    const privateRuntime=path.join(temp,'xdg-runtime');await fs.mkdir(privateRuntime,{mode:0o700});
    const env={...process.env,HOME:temp,XDG_CONFIG_HOME:path.join(temp,'config'),XDG_DATA_HOME:path.join(temp,'data'),XDG_CACHE_HOME:path.join(temp,'cache'),
      XDG_RUNTIME_DIR:privateRuntime,XDG_SESSION_TYPE:'x11'};
    for(const key of ['LD_PRELOAD','LD_LIBRARY_PATH','WAYLAND_DISPLAY','MANGOHUD','ENABLE_GAMESCOPE_WSI','FONTCONFIG_FILE','FONTCONFIG_PATH'])delete env[key];
    xvfb=child('Xvfb',['-displayfd','3','-screen','0','1920x1080x24','-nolisten','tcp'],env,true);
    let display='';xvfb.stdio[3].on('data',data=>display+=data);
    await until(()=>/^\d+\n/.test(display));env.DISPLAY=':'+display.trim();
    const xread=async(command,args)=>(await executeFile(command,args,{env,timeout:3000,maxBuffer:65536})).stdout;
    windowManager=child('openbox',['--sm-disable'],env);
    await until(async()=>/_NET_SUPPORTING_WM_CHECK.*0x[1-9a-f][0-9a-f]*/i.test(await xread('xprop',['-root','_NET_SUPPORTING_WM_CHECK'])));
    const debugPort=await port();
    nw=child(path.resolve(runtime),['--disable-gpu','--ozone-platform=x11','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(temp,'profile'),temp],env);
    const target=await until(async()=>{
      if(nw.exitCode!==null)throw Error(nw.diagnostic);
      const values=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list',{signal:AbortSignal.timeout(1000)})).json();
      return values.find(value=>value.url.includes('/menu/index.html'));
    },15000);
    ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    let next=0;const pending=new Map();
    ws.addEventListener('message',event=>{const value=JSON.parse(event.data);const item=pending.get(value.id);if(item){pending.delete(value.id);clearTimeout(item.timer);value.error?item.reject(Error(JSON.stringify(value.error))):item.resolve(value.result);}});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},5000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
    const js=async expression=>{const value=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value;};
    const check=async(name,expression)=>{assert.ok(await js(expression),name);passed.push(name);};
    const click=async id=>{await js(`document.getElementById(${JSON.stringify(id)}).click()`);await wait(100);};
    const screenshot=async name=>{const value=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(screenshots,name+'.png'),Buffer.from(value.data,'base64'));};
    const visible=`(id)=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return !e.hidden&&r.width>0&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth}`;
    await call('Emulation.setFocusEmulationEnabled',{enabled:true});
    await until(()=>js('!document.getElementById("options").disabled'));
    await check('NW stays in normal window mode','nw.Window.get().isFullscreen===false');
    const inspectWindow=async()=>{
      const clients=await xread('xprop',['-root','_NET_CLIENT_LIST']);
      const tree=await xread('xwininfo',['-root','-tree']);
      const windowIds=[...new Set([...(clients.match(/0x[0-9a-f]+/ig)||[]),
        ...Array.from(tree.matchAll(/^\s+(0x[0-9a-f]+)\b/gim),match=>match[1])])];
      if(windowIds.length>128)throw Error('Private X11 fixture unexpectedly has more than128 windows');
      const probe={time:new Date().toISOString(),spawnPid:nw.pid,display:env.DISPLAY,clients,tree,windows:[],
        native:await js('(()=>{const w=nw.Window.get();return {pid:process.pid,readyState:document.readyState,onceType:typeof w.once,showType:typeof w.show,maximizeType:typeof w.maximize,startupErrors:window.fixtureStartupErrors,consoleErrors:window.fixtureConsoleErrors,isFullscreen:w.isFullscreen,x:w.x,y:w.y,width:w.width,height:w.height,innerWidth,innerHeight,screenWidth:screen.width,screenHeight:screen.height}})()'),
        root:await xread('xprop',['-root','_NET_DESKTOP_GEOMETRY','_NET_WORKAREA','_NET_ACTIVE_WINDOW','_NET_SUPPORTING_WM_CHECK'])};
      windowProbes.push(probe);if(windowProbes.length>3)windowProbes.shift();
      for(const id of windowIds){
        const state=await xread('xprop',['-id',id,'_NET_WM_PID','_NET_WM_STATE','WM_CLASS','WM_NAME','_NET_WM_NAME','_NET_FRAME_EXTENTS']);
        const pid=Number(state.match(/_NET_WM_PID\(CARDINAL\) = (\d+)/)?.[1]);
        if(!Number.isInteger(pid)||pid<=0){probe.windows.push({window:id,pid:null,state});continue;}
        const info=await xread('xwininfo',['-id',id]);
        const field=name=>Number(info.match(new RegExp('^\\s*'+name+':\\s*(-?\\d+)','m'))?.[1]);
        const geometry={x:field('Absolute upper-left X'),y:field('Absolute upper-left Y'),width:field('Width'),height:field('Height')};
        const ancestry=[];let ancestor=pid;
        for(let i=0;i<8&&Number.isInteger(ancestor)&&ancestor>0;i++){
          try {
            const stat=await fs.readFile(`/proc/${ancestor}/stat`,'utf8');
            const parent=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
            const executable=await fs.readlink(`/proc/${ancestor}/exe`).catch(()=>null);
            ancestry.push({pid:ancestor,ppid:parent,executable});
            if(ancestor===nw.pid||parent===ancestor)break;ancestor=parent;
          }catch(error){ancestry.push({pid:ancestor,error:error.code||error.message});break;}
        }
        const viewable=/Map State:\s*IsViewable/.test(info);
        const overrideRedirect=/Override Redirect State:\s*yes/i.test(info);
        const owned=ancestry.some(entry=>entry.pid===nw.pid);
        probe.windows.push({window:id,pid,state,geometry,rawGeometry:info,ancestry,owned,viewable,overrideRedirect});
        const frame=state.match(/_NET_FRAME_EXTENTS\(CARDINAL\) = (\d+), (\d+), (\d+), (\d+)/)?.slice(1).map(Number);
        const workArea=probe.root.match(/_NET_WORKAREA\(CARDINAL\) = (\d+), (\d+), (\d+), (\d+)/)?.slice(1).map(Number);
        const outer=frame?{x:geometry.x-frame[0],y:geometry.y-frame[2],
          width:geometry.width+frame[0]+frame[1],height:geometry.height+frame[2]+frame[3]}:null;
        const maximized=state.includes('_NET_WM_STATE_MAXIMIZED_HORZ')&&state.includes('_NET_WM_STATE_MAXIMIZED_VERT');
        const exactGeometry=outer&&workArea&&outer.x===workArea[0]&&outer.y===workArea[1]&&
          outer.width===workArea[2]&&outer.height===workArea[3];
        if(owned&&viewable&&!overrideRedirect&&probe.native.isFullscreen===false&&
            !state.includes('_NET_WM_STATE_FULLSCREEN')&&maximized&&exactGeometry&&frame[2]>0)
          return {window:id,pid,spawnPid:nw.pid,fullscreen:false,maximized:true,geometry,outer,frame,workArea,
            windowMode:'wm-maximized',legacyManifestFullscreen:false,
            rawTree:tree,rawState:state,rawGeometry:info,ancestry};
      }
      return null;
    };
    if(!menuOnly){
      windowEvidence=await until(inspectWindow);
      passed.push('X11 confirms a visible decorated maximized window filling the work area, without fullscreen');
      await screenshot('maximized-startup');
    }
    await check('No controller or HUD calls on startup','fixture.controllerReads===0&&fixture.hudReads===0&&fixture.controllerWrites.length===0&&fixture.hudWrites.length===0');
    for(const [width,height]of[[1280,720],[800,600]]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await click('options');
      await check(`Options labels and descriptions fit ${width}x${height}`,`(()=>{const visible=${visible};return ['add-to-steam','open-controller','open-hud','uninstall','complete-uninstall'].every(id=>visible(id)&&document.getElementById(id).querySelector('small')?.textContent.length>10)&&document.documentElement.scrollHeight<=innerHeight})()`);
      await screenshot('options-'+width);
      await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
      await check('Keyboard moves from Steam entry to controller at '+width,'document.activeElement.id==="open-controller"');
      await click('open-controller');
      await check('Desktop controller scope and buttons visible at '+width,`(()=>{const visible=${visible};return ['controller-back','controller-apply','controller-deck','controller-xbox'].every(visible)&&document.querySelector('.controller-scope').getBoundingClientRect().bottom<=innerHeight})()`);
      await screenshot('controller-'+width);
      await click('controller-back');
      await js('document.querySelector("#options-view [data-action=back]").click()');
    }
    await click('options');await click('open-controller');
    await check('DualSense remains honest and opening does not select or write','document.getElementById("controller-live").textContent==="DualSense"&&document.getElementById("controller-apply").disabled&&fixture.controllerWrites.length===0');
    await click('controller-xbox');await check('Controller choice alone does not apply','!document.getElementById("controller-apply").disabled&&fixture.controllerWrites.length===0');
    await click('controller-back');
    await js('fixture.controller.available=false;fixture.controller.reason="Use Armada Control in Gaming Mode. Switch to Desktop Mode to change this setting here."');
    await click('open-controller');await check('Gaming Mode disables mutation and shows Armada Control direction','document.getElementById("controller-deck").disabled&&document.getElementById("controller-xbox").disabled&&document.getElementById("controller-apply").disabled&&document.getElementById("controller-status").textContent.includes("Armada Control")');
    await click('controller-back');await click('open-hud');
    await check('HUD opens read-only with explicit command','fixture.hudReads===1&&fixture.hudWrites.length===0&&document.getElementById("hud-apply").disabled&&document.getElementById("hud-command").textContent.includes("font_size=18")');
    await click('hud-on');await check('HUD On preview does not write','fixture.hudWrites.length===0&&!document.getElementById("hud-apply").disabled');
    await screenshot('hud-800');await click('hud-apply');
    await check('HUD applies only on request with concurrency token','fixture.hudWrites.length===1&&fixture.hudWrites[0].enabled===true&&fixture.hudWrites[0].options.token==="fixture-token"&&fixture.hudWrites[0].options.expectedLaunchOptions==="/usr/libexec/armada/armada-game-launch %command%"&&document.getElementById("hud-error").textContent.includes("Saved")');
    await click('hud-off');await click('hud-apply');await check('HUD Off can be applied','fixture.hudWrites.length===2&&fixture.hudWrites[1].enabled===false');
    await click('hud-back');await js('fixture.hud.enabled=true;fixture.hud.launchOptions="mangohud /usr/libexec/armada/armada-game-launch %command%"');
    await click('open-hud');await check('Existing plain MangoHud remains eligible for size/position normalization','!document.getElementById("hud-apply").disabled');
    await js('fixture.hudError="Steam launch options changed. Reopen MangoHud before retrying."');await click('hud-apply');
    await check('HUD failure is visible and requires fresh status before retry',`(()=>{const visible=${visible};return visible('hud-error')&&document.getElementById('hud-error').textContent.includes('Steam launch options changed')&&document.getElementById('hud-apply').disabled})()`);
    await screenshot('hud-error-800');
    await click('hud-back');
    await js('fixture.uninstallPreviewError="Cannot inspect the connected game binding. Nothing was removed."');
    await click('complete-uninstall');
    await check('Connected uninstall preview failure has a dedicated visible error screen',`(()=>{const visible=${visible};return !document.getElementById('operation-error-view').hidden&&document.getElementById('options-view').hidden&&visible('operation-error')&&visible('operation-error-back')&&document.getElementById('operation-error').textContent===fixture.uninstallPreviewError&&document.activeElement.id==='operation-error-back'})()`);
    await check('Failed preview never disconnects or removes the connected game','fixture.bound&&fixture.uninstallPreviews===1&&fixture.disconnectCalls===0&&fixture.completeUninstallCalls===0');
    await screenshot('uninstall-preview-error-800');
    await click('operation-error-back');
    await check('Preview error returns to Options without requiring Disconnect','!document.getElementById("options-view").hidden&&!document.getElementById("complete-uninstall").disabled&&fixture.bound&&fixture.disconnectCalls===0');
    await js('fixture.uninstallPreviewError=""');await click('complete-uninstall');
    await check('Connected complete-uninstall preview defaults to Cancel and does not remove anything','!document.getElementById("complete-preview-view").hidden&&document.activeElement.id==="cancel-complete"&&fixture.bound&&fixture.uninstallPreviews===2&&fixture.completeUninstallCalls===0&&fixture.disconnectCalls===0');
    await click('cancel-complete');
    await check('Cancelling connected uninstall keeps its binding and does not call either removal API','!document.getElementById("options-view").hidden&&fixture.bound&&fixture.completeUninstallCalls===0&&fixture.disconnectCalls===0');
    await js('fixture.completeUninstallError="Steam could not remove this shortcut. The launcher files were kept.";fixture.setupReadsBeforeRemoval=fixture.setupReads');
    await click('complete-uninstall');await click('confirm-complete');
    await check('Confirmed uninstall failure stays visible instead of dropping silently to Options',`(()=>{const visible=${visible};return !document.getElementById('operation-error-view').hidden&&document.getElementById('options-view').hidden&&visible('operation-error')&&visible('operation-error-back')&&document.getElementById('operation-error').textContent===fixture.completeUninstallError&&document.activeElement.id==='operation-error-back'})()`);
    await check('Failed confirmed uninstall refreshes setup while preserving the connected binding','fixture.completeUninstallCalls===1&&fixture.disconnectCalls===0&&fixture.bound&&fixture.setupReads>fixture.setupReadsBeforeRemoval');
    await screenshot('uninstall-removal-error-800');await click('operation-error-back');
    await check('Removal error Back returns to usable Options without implicit Disconnect','!document.getElementById("options-view").hidden&&!document.getElementById("uninstall").disabled&&!document.getElementById("complete-uninstall").disabled&&fixture.bound&&fixture.disconnectCalls===0');
    console.log(JSON.stringify({passed,checks:passed.length,screenshots,windowEvidence,window_verification:menuOnly?'not run':'visible decorated maximized window matches X11 work area',scope:'Real startup window helper and menu on private Xvfb/Openbox; mocked backend; no Steam, controller, game or save changes.'},null,2));
  } catch(error){
    const artifact=path.join(screenshots,'failure.json');
    const evidence={error:error.stack||String(error),window_verification:menuOnly?'not run':windowEvidence?'passed':'incomplete',passed,screenshots,windowEvidence,windowProbes,
      runtimeDiagnostic:nw?.diagnostic,displayDiagnostic:xvfb?.diagnostic,windowManagerDiagnostic:windowManager?.diagnostic};
    await fs.writeFile(artifact,JSON.stringify(evidence,null,2));
    const latest=windowProbes.at(-1);
    console.error(JSON.stringify({artifact,checksPassed:passed.length,lastPassed:passed.at(-1),
      display:latest?.display,spawnPid:nw?.pid,native:latest?.native,root:latest?.root,
      windows:latest?.windows.map(({window,pid,geometry,owned,viewable,overrideRedirect})=>
        ({window,pid,geometry,owned,viewable,overrideRedirect})),
      runtimeDiagnostic:nw?.diagnostic,windowManagerDiagnostic:windowManager?.diagnostic},null,2));
    throw error;
  }
  finally{clearTimeout(overall);ws?.close();await stop(nw);await stop(windowManager);await stop(xvfb);await fs.rm(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
