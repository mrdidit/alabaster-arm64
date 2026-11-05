'use strict';
// Real menu, mocked backend, private display. No game, Steam or system changes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtime = process.argv[2] || process.env.NW_RUNTIME;
if (!runtime) throw Error('Usage: node tests/options-ui.cjs /path/to/nwjs-sdk/nw');
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
 controller:{available:true,configured:'ds5',live:'ds5',supported:['deck-uhid','xb360'],targets:[],busy:false},
 hud:{ok:true,available:true,installed:true,supported:true,enabled:false,reason:'',appId:123,launchOptions:'/usr/libexec/armada/armada-game-launch %command%',manualLaunchOptions:'MANGOHUD_CONFIGFILE=/dev/null MANGOHUD_CONFIG=preset=2,no_display=0,position=bottom-right,font_size=18 mangohud /usr/libexec/armada/armada-game-launch %command%',token:'fixture-token'}};
window.launcherAPI={
 browseGame:async()=>{throw Error('Unexpected fixture browseGame call')},
 install:async()=>{throw Error('Unexpected fixture install call')},
 uninstall:async()=>{throw Error('Unexpected fixture uninstall call')},
 completeUninstall:async()=>{throw Error('Unexpected fixture completeUninstall call')},
 preview:async()=>{throw Error('Unexpected fixture save preview call')},
 sync:async()=>{throw Error('Unexpected fixture save sync call')},
 setupStatus:async()=>({installed:true,gamePath:'/fixture/game',defaultGamePath:'/fixture/game',edition:'full'}),
 finishSetup:async()=>({skipped:true}),
 status:async()=>({steam:{count:0,slots:[],autosave:{available:false}},arm64:{count:0,slots:[],autosave:{available:false}},busy:false}),
 addToSteam:async()=>({ok:true}),uninstallPreview:async()=>({root:'/fixture',removePaths:[],preservedPaths:[],warnings:[],bytes:0}),
 controllerStatus:async()=>{fixture.controllerReads++;return structuredClone(fixture.controller)},
 controllerSet:async type=>{fixture.controllerWrites.push(type);fixture.controller.configured=fixture.controller.live=type;return structuredClone(fixture.controller)},
 hudStatus:async()=>{fixture.hudReads++;return structuredClone(fixture.hud)},
 hudSet:async(enabled,options)=>{fixture.hudWrites.push({enabled,options});if(fixture.hudError)throw Error(fixture.hudError);fixture.hud.enabled=enabled;fixture.hud.launchOptions=enabled?fixture.hud.manualLaunchOptions:'/usr/libexec/armada/armada-game-launch %command%';fixture.hud.token+='-next';return structuredClone(fixture.hud)},
 play:async()=>{},exit:async()=>{}
};`;

(async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'alabaster-options-ui-'));
  const screenshots=await fs.mkdtemp(path.join(os.tmpdir(),'alabaster-options-screens-'));
  const passed=[]; let xvfb,nw,ws;
  const overall=setTimeout(()=>{console.error('Options UI exceeded 70 seconds');void stop(nw).then(()=>stop(xvfb)).finally(()=>process.exit(1));},70000);
  try {
    await fs.cp(path.join(root,'src/menu'),path.join(temp,'menu'),{recursive:true});
    const page=path.join(temp,'menu/index.html');
    await fs.writeFile(page,(await fs.readFile(page,'utf8')).replace('<script src="backend.js" defer></script>','<script src="fixture.js" defer></script>'));
    await fs.writeFile(path.join(temp,'menu/fixture.js'),fixture);
    await fs.writeFile(path.join(temp,'package.json'),JSON.stringify({name:'alabaster-options-fixture',main:'menu/index.html',window:{width:1280,height:720,frame:false}}));
    const env={...process.env,HOME:temp,XDG_CONFIG_HOME:path.join(temp,'config'),XDG_DATA_HOME:path.join(temp,'data'),XDG_CACHE_HOME:path.join(temp,'cache')};
    for(const key of ['LD_PRELOAD','WAYLAND_DISPLAY','MANGOHUD','ENABLE_GAMESCOPE_WSI','FONTCONFIG_FILE','FONTCONFIG_PATH'])delete env[key];
    xvfb=child('Xvfb',['-displayfd','3','-screen','0','1920x1080x24','-nolisten','tcp'],env,true);
    let display='';xvfb.stdio[3].on('data',data=>display+=data);
    await until(()=>/^\d+\n/.test(display));env.DISPLAY=':'+display.trim();
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
    console.log(JSON.stringify({passed,checks:passed.length,screenshots,scope:'Mocked backend; no Steam, controller, game or save changes.'},null,2));
  } catch(error){console.error(JSON.stringify({passed,screenshots,runtimeDiagnostic:nw?.diagnostic,displayDiagnostic:xvfb?.diagnostic}));throw error;}
  finally{clearTimeout(overall);ws?.close();await stop(nw);await stop(xvfb);await fs.rm(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
