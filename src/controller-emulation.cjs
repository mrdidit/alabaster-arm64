'use strict';

const {execFile} = require('node:child_process');

const HELPER = '/usr/libexec/armada/controller-type';
const DEVICE_ENV = '/usr/libexec/armada/device-env';
const BUSCTL = '/usr/bin/busctl';
const PKEXEC = '/usr/bin/pkexec';
const SERVICE = 'org.shadowblip.InputPlumber';
const COMPOSITE = 'org.shadowblip.Input.CompositeDevice';
const TARGET = 'org.shadowblip.Input.Target';
const ALLOWED = ['deck-uhid', 'xb360'];
const KNOWN = ['deck-uhid', 'xbox-series', 'xb360', 'ds5'];
const EXTRAS = ['keyboard', 'mouse'];
const pathPattern = /^\/org\/shadowblip\/InputPlumber\/[A-Za-z0-9_/]+$/;
const compositePattern = /^\/org\/shadowblip\/InputPlumber\/CompositeDevice[0-9]+$/;
const normalized = values => [...new Set(values)].sort();
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function cleanEnvironment() {
  const env = {...process.env};
  for (const name of Object.keys(env))
    if (/^(?:LD_|PYTHON|BASH_)/.test(name) || ['VIRTUAL_ENV', 'VIRTUAL_ENV_PROMPT', 'ENV', 'SHELLOPTS',
      'ARMADA_DEVICE_DIR', 'ARMADA_MODEL', 'ARMADA_SLEEP_CONFIG', 'ARMADA_MEM_SLEEP_PATH'].includes(name)) delete env[name];
  env.PATH = '/usr/sbin:/usr/bin:/sbin:/bin';
  env.LC_ALL = 'C.UTF-8';
  return env;
}
function execute(file, args, options) {
  return new Promise((resolve, reject) => {
    let exited = false, timedOut = false, exitDone;
    const waitForExit = new Promise(done => { exitDone = done; });
    const child = execFile(file, args, {...options, timeout:0}, (error, stdout, stderr) => {
      clearTimeout(deadline);
      if (timedOut) return;
      if (error) {
        error.stdout = stdout; error.stderr = stderr;
        if (child.pid && !exited) { error.helperMayBeRunning = true; error.waitForExit = waitForExit; }
        reject(error);
      } else resolve({stdout, stderr});
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      const error = new Error('The command exceeded its time limit.');
      Object.assign(error, {timedOut:true, helperMayBeRunning:!exited, waitForExit});
      reject(error);
      try { child.kill('SIGTERM'); } catch { /* The elevated process may reject signals from this account. */ }
    }, options.timeout);
    child.once('exit', () => { exited = true; exitDone(); });
    child.once('error', () => { if (!child.pid) { exited = true; exitDone(); } });
    child.stdin?.end();
  });
}
function supportedTypes(source) {
  const line = source.split(/\r?\n/).find(line => /^ARMADA_IP_TARGETS=/.test(line));
  if (!line) return [...ALLOWED];
  let value = line.slice('ARMADA_IP_TARGETS='.length).trim();
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  else {
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    value = value.replace(/\\([,a-z0-9_-])/gi, '$1');
  }
  if (!/^[a-z0-9_,-]*$/i.test(value)) throw new Error('The device controller choices could not be read.');
  const configured = value.split(',').filter(value => KNOWN.includes(value));
  return configured.length ? ALLOWED.filter(value => configured.includes(value)) : [...ALLOWED];
}
function problem(error, fallback) {
  if (error?.code === 'ENOENT') return fallback;
  return typeof error?.message === 'string' ? error.message.replace(/[\x00-\x1f]+/g, ' ').slice(0, 500) : fallback;
}

function createControllerEmulation({isBusy = async () => false, run = execute, readTimeoutMs = 5000, applyTimeoutMs = 60000} = {}) {
  let applying = false;
  let pendingApply = null;
  const options = timeout => ({timeout, killSignal:'SIGTERM', maxBuffer:256*1024, encoding:'utf8', shell:false, env:cleanEnvironment()});
  const command = async (file, args, timeout = readTimeoutMs) => {
    const value = await run(file, args, options(timeout));
    return typeof value === 'string' ? value : String(value.stdout || '');
  };
  async function property(object, iface, name, type) {
    const source = await command(BUSCTL, ['--system', '--no-pager', '--json=short', 'get-property', SERVICE, object, iface, name]);
    let value;
    try { value = JSON.parse(source); } catch { throw new Error(`InputPlumber returned unreadable ${name} data.`); }
    if (value.type !== type) throw new Error(`InputPlumber returned an unexpected ${name} type.`);
    if (type === 'as') {
      if (!Array.isArray(value.data) || value.data.length > 64 || value.data.some(item => typeof item !== 'string' || !pathPattern.test(item)))
        throw new Error('InputPlumber returned invalid target paths.');
    } else if (typeof value.data !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(value.data))
      throw new Error('InputPlumber returned an invalid target device type.');
    return value.data;
  }
  async function scan() {
    const text = await command(BUSCTL, ['--system', '--no-pager', '--list', 'tree', SERVICE]);
    const paths = normalized(text.split(/\r?\n/).map(line => line.trim()).filter(line => compositePattern.test(line)));
    if (!paths.length) throw new Error('No InputPlumber controller devices are available.');
    if (paths.length > 32) throw new Error('Too many InputPlumber devices were returned to verify this switch.');
    return Promise.all(paths.map(async object => {
      const targetPaths = await property(object, COMPOSITE, 'TargetDevices', 'as');
      // DeviceType is the target's declared type; object path names are not a mapping.
      const values = await Promise.all(targetPaths.map(target => property(target, TARGET, 'DeviceType', 's')));
      return {path:object, types:normalized(values)};
    }));
  }
  async function inspect(ignoreApplying = false) {
    const results = await Promise.allSettled([
      command(HELPER, ['get']), command(DEVICE_ENV, []), scan(), Promise.resolve().then(isBusy),
    ]);
    let configured = null, targets = [], supported = [...ALLOWED], live = null;
    const failures = [];
    if (results[0].status === 'fulfilled' && /^[a-z0-9_-]{1,80}$/i.test(results[0].value.trim())) configured = results[0].value.trim();
    else failures.push(results[0].status === 'rejected' ? problem(results[0].reason, 'Armada controller emulation is unavailable on this system.') : 'The configured controller type could not be read.');
    if (results[1].status === 'fulfilled') {
      try { supported = supportedTypes(results[1].value); } catch (error) { failures.push(error.message); }
    }
    if (results[2].status === 'fulfilled') {
      targets = results[2].value;
      const active = normalized(targets.flatMap(item => item.types).filter(value => !EXTRAS.includes(value)));
      live = active.length === 1 ? active[0] : active.length > 1 ? 'mixed' : 'none';
    } else failures.push(problem(results[2].reason, 'InputPlumber live controller state is unavailable.'));
    if (results[3].status === 'rejected') failures.push('The game activity check failed. Close the game before changing controllers.');
    const busy = (applying && !ignoreApplying) || Boolean(pendingApply) || results[3].status === 'rejected' || Boolean(results[3].value);
    if (!supported.length) failures.push('This device does not advertise Steam Deck or Xbox 360 emulation.');
    return {available:!failures.length && !busy, configured, live, reason:failures.join(' ') || (pendingApply
      ? 'The previous privileged controller command may still be running. Wait for it to exit before applying another change.'
      : busy ? 'Close the game or wait for the current controller switch.' : ''),
      targets, supported, busy};
  }
  function matching(state, value, original = state.targets) {
    return state.configured === value && equal(state.targets.map(item=>item.path), original.map(item=>item.path)) &&
      original.every(before => {
        const actual = state.targets.find(item=>item.path === before.path);
        return actual && equal(actual.types, normalized([value, ...before.types.filter(type=>EXTRAS.includes(type))]));
      });
  }
  async function set(value) {
    if (!ALLOWED.includes(value)) throw new Error('Choose Steam Deck or Xbox 360.');
    if (applying) throw new Error('A controller switch is already running.');
    if (pendingApply) throw new Error('The previous privileged controller command may still be running. Another change cannot be started yet.');
    applying = true;
    try { return await apply(value); } finally { applying = false; }
  }
  async function apply(value) {
    const before = await inspect(true);
    if (!before.available) { const error = new Error(before.reason); error.state = before; throw error; }
    if (!before.supported.includes(value)) throw new Error('This controller type is not supported by the device profile.');
    if (matching(before, value)) return {...before, changed:false, message:'This controller emulation is already selected.'};
    let failure = null;
    try {
      if (await isBusy()) throw new Error('Close the game before changing controller emulation.');
      await command(PKEXEC, ['--disable-internal-agent', HELPER, 'set', value], applyTimeoutMs);
    } catch (error) {
      failure = error;
      if (error.timedOut || error.helperMayBeRunning || error.killed || error.code === 'ETIMEDOUT' || error.code === 'EPERM' || error.signal) {
        const pending = pendingApply = {};
        if (typeof error.waitForExit?.then === 'function') error.waitForExit.then(() => {
          if (pendingApply === pending) pendingApply = null;
        }, () => {});
      }
    }
    const state = await inspect(true);
    const verified = state.available && matching(state, value, before.targets);
    if (!failure && verified) return {...state, changed:true, message:'Controller emulation changed and verified.'};
    const timedOut = failure?.timedOut || failure?.helperMayBeRunning || failure?.killed || failure?.code === 'ETIMEDOUT' || failure?.code === 'ABORT_ERR' || Boolean(failure?.signal);
    const changed = before.configured !== state.configured || !equal(before.targets, state.targets);
    const denied = failure && [126, 127].includes(failure.code);
    const reason = timedOut
      ? 'Controller switching timed out. The privileged helper may still be running; a partial change is possible. Check Armada Control before retrying.'
      : denied
        ? 'Controller authorization was cancelled or unavailable. Open the launcher in Desktop Mode with an authentication agent, then retry.'
        : failure?.code === 'ENOENT'
          ? 'Polkit authorization is unavailable. The controller switch could not be started.'
          : failure
            ? `The controller switch failed. ${problem(failure, 'Check Armada Control before retrying.')}`
            : 'Controller switching could not be verified for the saved setting and every original controller. A partial change is possible; check Armada Control before retrying.';
    const error = new Error(reason + (!state.available && state.reason ? ` Current readback: ${state.reason}` : ''));
    error.state = state;
    error.uncertain = Boolean(timedOut || changed || !state.available || (!failure && !verified));
    throw error;
  }
  return {status:() => inspect(), set};
}

module.exports = {createControllerEmulation};
