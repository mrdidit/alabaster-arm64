'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DEMO_HASH = '9d229ef692aff28cbd7ede74652b6948703ac49bb4f44c91762353ae5041a38f';
const RUNTIME = 'nwjs-v0.119.2-linux-arm64';
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function createSetup({root, home = os.homedir(), nativeDataPath, isBusy = async () => false}) {
  root = fs.realpathSync(root);
  home = fs.realpathSync(home);
  const statePath = path.join(root, 'setup.json');
  const editionPath = path.join(root, 'profile-edition.json');
  const binding = path.join(root, 'app', 'terra');
  const configPath = path.resolve(process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const configHome = fs.existsSync(configPath) ? fs.realpathSync(configPath) : configPath;
  const nativeProfile = nativeDataPath || path.join(root, 'profile', 'Default');
  let busy = false;
  let cached = null;

  function managedApp() {
    const app = path.join(root, 'app');
    const stat = fs.lstatSync(app);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(app) !== app)
      throw new Error('The launcher app directory must be a real directory inside this installation.');
    return app;
  }

  function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  function inspectGame(directory) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('Choose the Alabaster Dawn game folder.');
    const gameDir = fs.realpathSync(directory);
    if (inside(root, gameDir)) throw new Error('Choose the original Steam game folder, not the ARM64 launcher folder.');
    const manifest = readJSON(path.join(gameDir, 'package.json'));
    if (!manifest || !/^Alabaster Dawn(?: Demo)?$/i.test(manifest.name || '') || manifest.main !== 'terra/index.html')
      throw new Error('This folder is not a supported Alabaster Dawn installation. Select the folder containing package.json and terra.');
    const bundlePath = path.join(gameDir, 'terra', 'dist', 'bundle.js');
    const stat = fs.statSync(bundlePath);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('The game bundle is missing or invalid.');
    const cacheKey = `${gameDir}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const bundleSha256 = cached?.key === cacheKey ? cached.hash : crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
    cached = {key: cacheKey, hash: bundleSha256};
    const indexPath = path.join(gameDir, 'terra', 'index.html');
    if (!fs.statSync(indexPath).isFile()) throw new Error('The game entry page is missing.');
    const index = fs.readFileSync(indexPath, 'utf8');
    const variant = bundleSha256 === DEMO_HASH || /\bwindow\.XG_DEMO_VERSION\s*=\s*true\b/.test(index) ? 'demo' : 'full';
    return {variant, gameDir, bundlePath, bundleSha256,
      steamProfile: path.join(configHome, manifest.name), nativeDataPath: nativeProfile};
  }

  function getContext() {
    managedApp();
    const saved = readJSON(statePath);
    if (saved) {
      if (saved.schema !== 1 || typeof saved.gamePath !== 'string') throw new Error('The launcher setup record is invalid. Reinstall the ARM64 setup.');
      if (!fs.existsSync(path.join(binding, 'index.html'))) return null;
      return inspectGame(saved.gamePath);
    }
    if (!fs.existsSync(path.join(binding, 'index.html'))) return null;
    const dist = fs.realpathSync(path.join(binding, 'dist'));
    return inspectGame(path.resolve(dist, '..', '..'));
  }

  function defaultGamePath() {
    const libraries = new Set([path.join(home, '.local/share/Steam'), path.join(home, '.steam/steam')]);
    for (const base of [...libraries]) {
      try {
        const text = fs.readFileSync(path.join(base, 'steamapps/libraryfolders.vdf'), 'utf8');
        for (const match of text.matchAll(/"path"\s+"((?:\\.|[^"\\])*)"/g)) libraries.add(match[1].replace(/\\\\/g, '\\'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const name of ['Alabaster Dawn', 'Alabaster Dawn Demo']) {
      for (const base of libraries) {
        const candidate = path.join(base, 'steamapps/common', name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      }
    }
    return path.join(home, '.local/share/Steam/steamapps/common/Alabaster Dawn');
  }

  async function setupStatus() {
    const defaultPath = defaultGamePath();
    try {
      const context = getContext();
      return {installed: Boolean(context), gamePath: context?.gameDir || '', defaultGamePath: defaultPath,
        edition: context?.variant || '', detail: ''};
    } catch (error) {
      return {installed: false, gamePath: '', defaultGamePath: defaultPath, edition: '', detail: error.message};
    }
  }

  async function writeJSON(file, value) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      await fsp.rename(temporary, file);
    } finally { await fsp.rm(temporary, {force: true}); }
  }

  async function ensureIdle() {
    if (await isBusy()) throw new Error('Close both versions of Alabaster Dawn before changing setup.');
  }

  function profileHasData() {
    const directory = path.dirname(nativeProfile);
    if (!fs.existsSync(directory)) return false;
    return fs.readdirSync(directory, {recursive: true}).some(name => /(?:\.save$|(?:^|[/\\])Saves(?:[/\\]|$))/.test(name));
  }

  async function install(gamePath, progress = () => {}) {
    if (busy) throw new Error('Setup is already running.');
    busy = true;
    const stage = path.join(root, 'app', `.terra-setup-${crypto.randomUUID()}`);
    const old = path.join(root, 'app', `.terra-before-${crypto.randomUUID()}`);
    let swapped = false;
    let moved = false;
    let committed = false;
    let oldState;
    const report = value => { try { progress(value); } catch {} };
    try {
      managedApp();
      await ensureIdle();
      report({message: 'Checking game files…', percent: 10});
      const context = inspectGame(gamePath);
      let previous;
      try { previous = getContext(); }
      catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
      const profileEdition = readJSON(editionPath)?.variant || previous?.variant;
      if (profileHasData() && (!profileEdition || profileEdition !== context.variant))
        throw new Error('This launcher profile contains saves from another edition. Use a separate launcher installation for the full game to keep demo saves separate.');
      const runtime = path.join(root, 'runtime', RUNTIME, 'nw');
      await fsp.access(runtime, fs.constants.X_OK);
      report({message: 'Preparing ARM64 launch…', percent: 40});
      await fsp.mkdir(stage);
      for (const name of await fsp.readdir(path.join(context.gameDir, 'terra'))) {
        const source = path.join(context.gameDir, 'terra', name);
        if (name === 'index.html') await fsp.copyFile(source, path.join(stage, name));
        else await fsp.symlink(source, path.join(stage, name));
      }
      await ensureIdle();
      oldState = readJSON(statePath);
      if (fs.existsSync(binding)) { await fsp.rename(binding, old); moved = true; }
      await fsp.rename(stage, binding); swapped = true;
      await writeJSON(statePath, {schema: 1, gamePath: context.gameDir, variant: context.variant,
        bundleSha256: context.bundleSha256, runtime: RUNTIME, installedAt: new Date().toISOString()});
      await writeJSON(editionPath, {schema: 1, variant: context.variant});
      committed = true;
      report({message: 'Installed', percent: 100});
      return {installed: true, gamePath: context.gameDir, defaultGamePath: context.gameDir, edition: context.variant};
    } catch (error) {
      if (swapped) {
        await fsp.rm(binding, {recursive: true, force: true});
        if (oldState) await writeJSON(statePath, oldState); else await fsp.rm(statePath, {force: true});
      }
      if (moved) { await fsp.rename(old, binding); moved = false; }
      throw error;
    } finally {
      await fsp.rm(stage, {recursive: true, force: true});
      if (committed) await fsp.rm(old, {recursive: true, force: true});
      busy = false;
    }
  }

  async function uninstall() {
    if (busy) throw new Error('Setup is already running.');
    busy = true;
    try {
      managedApp();
      await ensureIdle();
      let context;
      try { context = getContext(); }
      catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
      if (context && !readJSON(editionPath)) await writeJSON(editionPath, {schema: 1, variant: context.variant});
      const stat = await fsp.lstat(binding).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat?.isSymbolicLink()) await fsp.unlink(binding);
      else if (stat) await fsp.rm(binding, {recursive: true});
      await fsp.rm(statePath, {force: true});
      return await setupStatus();
    } finally { busy = false; }
  }

  return {setupStatus, getContext, install, uninstall};
}

module.exports = {createSetup};
