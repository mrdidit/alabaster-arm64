'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const RUNTIME = 'nwjs-v0.119.2-linux-arm64';
const MODULES = ['alabaster-dawn.arm64', 'launcher.c', 'setup.cjs', 'save-transfer.cjs', 'steam-cloud.cjs',
  'cloud-sync.cjs', 'steam-shortcut.cjs', 'uninstall.cjs', 'controller-emulation.cjs', 'setup.json', '.steam-shortcut-pending',
  'steam-shortcut.json', 'steam-shortcut-pending.json', '.setup.lock'];
const MENU = ['index.html', 'backend.js', 'menu.js', 'menu.css', 'window.js', 'assets/THIRD_PARTY.txt', 'assets/hero.jpg', 'assets/logo.png',
  'assets/title-arm64.png', 'assets/steam/portrait.png', 'assets/steam/wide.png', 'assets/steam/hero.png',
  'assets/steam/logo.png', 'assets/fonts/LICENSE.txt', 'assets/fonts/NOTICE.txt', 'assets/fonts/fonts.conf',
  'assets/fonts/NotoSerif-Regular.ttf', 'assets/fonts/NotoSans-Regular.ttf', 'assets/fonts/NotoSans-Bold.ttf',
  'assets/fonts/NotoSansSymbols-Regular.ttf', 'assets/fonts/NotoSansSymbols2-Regular.ttf'];
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const exists = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const fingerprint = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs];
const identity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeMs];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function desktopExecutable(source) {
  let section = '', value = null;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line) || !line.trim()) continue;
    if (/^\[.*\]$/.test(line)) { section = line; continue; }
    if (section !== '[Desktop Entry]' || !line.startsWith('Exec=')) continue;
    if (value !== null) return null;
    value = line.slice(5);
  }
  if (value === null) return null;
  let decoded = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') { decoded += value[i]; continue; }
    const next = value[++i];
    const escapes = {'\\':'\\', s:' ', n:'\n', t:'\t', r:'\r'};
    if (!Object.hasOwn(escapes, next)) return null;
    decoded += escapes[next];
  }
  let executable = '';
  if (decoded.startsWith('"')) {
    let closed = false;
    for (let i = 1; i < decoded.length; i++) {
      const char = decoded[i];
      if (char === '"') { if (i !== decoded.length - 1) return null; closed = true; break; }
      if (char === '\\') {
        const next = decoded[++i];
        if (!['"', '\\', '$', '`'].includes(next)) return null;
        executable += next;
      } else executable += char;
    }
    if (!closed) return null;
  } else {
    if (/[\s"'\\`$<>~|&;]/.test(decoded)) return null;
    executable = decoded;
  }
  if (/%(?!%)/.test(executable.replace(/%%/g, '')) || /[\0\r\n]/.test(executable)) return null;
  executable = executable.replace(/%%/g, '%');
  return path.isAbsolute(executable) ? executable : null;
}

function desktopIdentity(source) {
  let section = '';
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line) || !line.trim()) continue;
    if (/^\[.*\]$/.test(line)) { section = line; continue; }
    if (section !== '[Desktop Entry]') continue;
    const match = /^(Name|Type)=(.*)$/.exec(line);
    if (!match) continue;
    if (Object.hasOwn(values, match[1])) return null;
    values[match[1]] = match[2];
  }
  return values.Type === 'Application' ? values.Name : null;
}

function createUninstall({root, home = os.homedir(), isBusy = async () => false, removeSteamShortcut} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('An exact launcher installation path is required.');
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('The installation root must not be a symbolic link.');
  root = fs.realpathSync(root);
  home = fs.realpathSync(home);
  if (root === path.parse(root).root || inside(root, home)) throw new Error('Uninstall cannot operate on the home directory or one of its parents.');
  const initialRoot = fs.lstatSync(root);
  const uid = process.getuid();
  if (!initialRoot.isDirectory() || initialRoot.uid !== uid) throw new Error('The installation directory is not owned by this account.');
  let busy = false;

  function checkRoot() {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.dev !== initialRoot.dev || stat.ino !== initialRoot.ino || fs.realpathSync(root) !== root)
      throw new Error('The launcher installation directory changed. No further files were removed.');
  }
  function parents(file) {
    const relative = path.relative(root, path.dirname(file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('A managed path escapes the installation directory.');
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = exists(current);
      if (!stat) return false;
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.dev !== initialRoot.dev)
        throw new Error(`A managed parent is linked, unowned or on another filesystem: ${current}`);
    }
    return true;
  }
  function tree(file) {
    const entries = [];
    function visit(current) {
      const stat = fs.lstatSync(current);
      if (stat.uid !== uid || stat.dev !== initialRoot.dev || (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()))
        throw new Error(`A managed path has an unsupported owner or type: ${current}`);
      entries.push([path.relative(file, current), fingerprint(stat), stat.isSymbolicLink() ? fs.readlinkSync(current) : null]);
      if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
    }
    visit(file);
    return entries;
  }
  function validateInstallation() {
    checkRoot();
    if (fs.readdirSync(root).some(name => /^\.setup-/.test(name)))
      throw new Error('An installation staging directory is present. Finish or review setup before uninstalling.');
    if (fs.readdirSync(root).some(name => /^\.uninstall-/.test(name)))
      throw new Error('A previous uninstall staging directory is present. Review the retained application files before retrying.');
    const app = path.join(root, 'app/package.json');
    if (!parents(app)) throw new Error('This is not an installed Alabaster Dawn ARM64 launcher.');
    const manifest = exists(app), launcher = exists(path.join(root, 'alabaster-dawn.arm64'));
    if (!manifest?.isFile() || manifest.uid !== uid || manifest.size > 1024 * 1024 || !launcher?.isFile() || launcher.uid !== uid)
      throw new Error('The launcher installation cannot be identified. No files were removed.');
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(app, 'utf8')); } catch { throw new Error('The launcher manifest is invalid. No files were removed.'); }
    if (!/^Alabaster Dawn ARM64(?: Test)?$/.test(metadata.name || '') || metadata.main !== 'menu/index.html')
      throw new Error('This directory is not a recognized ARM64 launcher installation. No files were removed.');
    const fd = fs.openSync(path.join(root, 'alabaster-dawn.arm64'), 'r');
    const header = Buffer.alloc(20);
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    if (!header.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) || header.readUInt16LE(18) !== 183)
      throw new Error('The launcher executable is not the expected ARM64 program. No files were removed.');
  }
  function desktopDirectories() {
    const data = path.resolve(process.env.XDG_DATA_HOME || path.join(home, '.local/share'));
    const config = path.resolve(process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
    let desktop = path.join(home, 'Desktop');
    const dirs = path.join(config, 'user-dirs.dirs');
    const stat = exists(dirs);
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.size <= 65536) {
      const matches = [...fs.readFileSync(dirs, 'utf8').matchAll(/^XDG_DESKTOP_DIR="([^"\r\n]*)"\s*$/gm)];
      if (matches.length === 1) {
        let value = matches[0][1];
        if (value === '$HOME' || value.startsWith('$HOME/')) value = home + value.slice(5);
        if (path.isAbsolute(value) && !/[\\$`]/.test(value)) desktop = value;
      }
    }
    return [...new Set([path.join(data, 'applications'), ...(path.resolve(desktop) === home ? [] : [desktop])])];
  }
  function legacyDesktop(source, executable) {
    // Historical installers used these exact home-relative targets. Only the
    // shortcut is removed; their installations, runtime and save data remain.
    const name = desktopIdentity(source);
    const legacy = [
      ['Alabaster-Dawn-ARM64', 'alabaster-dawn.arm64', 'Alabaster Dawn ARM64'],
      ['Alabaster-Dawn-ARM64-Test', 'alabaster-dawn.arm64', 'Alabaster Dawn ARM64 Test'],
      ['Alabaster-Dawn-ARM64-Test', 'launch.sh', 'Alabaster Dawn ARM64 Test'],
    ].find(([directory, binary, title]) => name === title && executable === path.join(home, 'Games', directory, binary));
    if (!legacy) return false;
    let current = home;
    for (const part of ['Games', legacy[0]]) {
      current = path.join(current, part);
      const stat = exists(current);
      // Missing historical roots are expected for stale shortcuts. Existing
      // ancestors must still be owned directories, never aliases elsewhere.
      if (!stat) return true;
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) return false;
    }
    const binary = exists(executable);
    return !binary || (binary.isFile() && !binary.isSymbolicLink() && binary.uid === uid);
  }
  function collect() {
    validateInstallation();
    const entries = [], warnings = [], keep = new Set(['profile', 'profile-edition.json', 'save-backups', 'cloud-backups', 'cloud-recovery.json', 'logs']);
    function add(relative, directory = false) {
      const file = path.join(root, relative);
      if (!parents(file)) return;
      const stat = exists(file);
      if (!stat) return;
      if (stat.isDirectory() && !directory) throw new Error(`Expected a managed file, found a directory: ${file}`);
      const snapshot = tree(file);
      entries.push({path:file, external:false, snapshot, identity:identity(stat), bytes:snapshot.reduce((n, entry)=>n + ((entry[1][2] & 0o170000) === 0o100000 ? entry[1][4] : 0), 0)});
    }
    for (const name of MODULES) add(name);
    add('app/package.json');
    for (const base of ['menu', 'app/menu']) {
      const file = path.join(root, base);
      if (!parents(file)) continue;
      const stat = exists(file);
      if (stat?.isSymbolicLink()) add(base);
      else if (stat) for (const name of MENU) add(`${base}/${name}`);
    }
    const binding = path.join(root, 'app/terra');
    if (parents(binding)) {
      const stat = exists(binding);
      if (stat?.isSymbolicLink()) add('app/terra');
      else if (stat) {
        if (!stat.isDirectory() || stat.uid !== uid || stat.dev !== initialRoot.dev) throw new Error('The game binding is not an owned directory.');
        for (const name of fs.readdirSync(binding)) {
          const child = fs.lstatSync(path.join(binding, name));
          if (child.isSymbolicLink() || (name === 'index.html' && child.isFile())) add(`app/terra/${name}`);
          else { keep.add(`app/terra/${name}`); warnings.push(`Unrecognized game-binding content was kept: ${name}`); }
        }
      }
    }
    add(`runtime/${RUNTIME}`, true);
    add(`downloads/${RUNTIME}.tar.gz`);
    for (const folder of desktopDirectories()) {
      const stat = exists(folder);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) { warnings.push(`Shortcut directory was not inspected: ${folder}`); continue; }
      for (const name of fs.readdirSync(folder).filter(name=>name.endsWith('.desktop')).sort()) {
        const file = path.join(folder, name), item = fs.lstatSync(file);
        if (!item.isFile() || item.isSymbolicLink() || item.uid !== uid || item.size > 65536) {
          if (/alabaster/i.test(name)) warnings.push(`A linked, unowned or oversized shortcut was kept: ${file}`);
          continue;
        }
        const source = fs.readFileSync(file, 'utf8'), executable = desktopExecutable(source);
        if (!executable) {
          if (source.includes('alabaster-dawn.arm64')) warnings.push(`An ambiguous shortcut was kept: ${file}`);
          continue;
        }
        let parent;
        try { parent = fs.realpathSync(path.dirname(executable)); } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
        const currentTarget = parent === root && path.basename(executable) === 'alabaster-dawn.arm64';
        if (!currentTarget && !legacyDesktop(source, executable)) continue;
        entries.push({path:file, external:true, snapshot:[['', fingerprint(item), null]], identity:identity(item), bytes:item.size});
      }
    }
    const targets = entries.filter(item=>!item.external).map(item=>item.path);
    function preserved(directory) {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        if (targets.includes(file)) continue;
        if (targets.some(target=>inside(file,target))) preserved(file);
        else keep.add(path.relative(root,file));
      }
    }
    preserved(root);
    const preservedPaths = [...keep].filter(name=>exists(path.join(root,name))).map(name=>path.join(root,name));
    return {entries, root, removePaths:entries.map(item=>item.path), preservedPaths, warnings,
      bytes:entries.reduce((sum,item)=>sum+item.bytes,0)};
  }
  async function idle() { if (await isBusy()) throw new Error('Close both versions of Alabaster Dawn before uninstalling the launcher.'); }
  function outward(plan) { return {root:plan.root, removePaths:plan.removePaths, preservedPaths:plan.preservedPaths, warnings:plan.warnings, bytes:plan.bytes}; }
  async function preview() { if (busy) throw new Error('Uninstall is already running.'); await idle(); return outward(collect()); }
  async function uninstall() {
    if (busy) throw new Error('Uninstall is already running.');
    busy = true;
    let staging = null, deleting = false, steamResult = null;
    const moved = [], removedPaths = [];
    try {
      await idle();
      const plan = collect();
      if (typeof removeSteamShortcut !== 'function') throw new Error('Steam entry removal is unavailable. The launcher files were kept.');
      const steamShortcut = await removeSteamShortcut();
      if (!steamShortcut?.ok) throw new Error(steamShortcut?.warning || steamShortcut?.message || 'The Steam entry could not be removed. The launcher files were kept.');
      steamResult = steamShortcut;
      await idle();
      const current = collect();
      if (!equal(plan.entries, current.entries)) throw new Error('Launcher files or shortcuts changed during Steam removal. Local files were kept; review and retry.');
      staging = fs.mkdtempSync(path.join(root, '.uninstall-'));
      fs.chmodSync(staging, 0o700);
      fs.writeFileSync(path.join(staging, 'plan.json'), JSON.stringify({schema:1, root, paths:plan.removePaths}, null, 2)+'\n', {mode:0o600});
      for (const [index, item] of plan.entries.entries()) {
        checkRoot();
        if (!equal(item.snapshot, item.external ? [['',fingerprint(fs.lstatSync(item.path)),null]] : tree(item.path)))
          throw new Error(`A managed path changed before removal: ${item.path}`);
        const destination = item.external ? path.join(path.dirname(item.path), `.alabaster-uninstall-${path.basename(staging)}-${index}`) : path.join(staging, String(index));
        if (exists(destination)) throw new Error('An uninstall staging path already exists. Retry after reviewing it.');
        fs.renameSync(item.path, destination);
        moved.push({...item, staged:destination});
      }
      deleting = true;
      for (const item of moved) { fs.rmSync(item.staged, {recursive:true}); removedPaths.push(item.path); }
      fs.rmSync(staging, {recursive:true}); staging = null;
      const parentsToPrune = new Set();
      for (const item of plan.entries.filter(item=>!item.external)) {
        let parent = path.dirname(item.path);
        while (parent !== root && inside(root,parent)) { parentsToPrune.add(parent); parent = path.dirname(parent); }
      }
      for (const directory of [...parentsToPrune].sort((a,b)=>b.length-a.length)) {
        const stat = exists(directory);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
        try { fs.rmdirSync(directory); } catch (error) { if (!['ENOTEMPTY','ENOENT'].includes(error.code)) current.warnings.push(`An empty application directory remains: ${directory}`); }
      }
      return {ok:true, removed:true, removedPaths, preservedPaths:current.preservedPaths, warnings:current.warnings, steamShortcut};
    } catch (error) {
      if (steamResult) error.steamShortcut = steamResult;
      const recoveryPaths = [];
      if (!deleting) for (const item of moved.reverse()) {
        try {
          if (exists(item.path) || !equal(identity(fs.lstatSync(item.staged)), item.identity)) throw new Error('Path changed during rollback');
          fs.renameSync(item.staged, item.path);
        } catch { recoveryPaths.push(item.staged); }
      }
      else for (const item of moved) if (exists(item.staged)) recoveryPaths.push(item.staged);
      if (staging && !recoveryPaths.length) { try { fs.rmSync(staging, {recursive:true}); } catch { recoveryPaths.push(staging); } }
      if (deleting || recoveryPaths.length) {
        error.partial = true; error.removedPaths = removedPaths; error.recoveryPaths = recoveryPaths;
        error.message = `Uninstall did not complete. ${error.message}${recoveryPaths.length ? ` Retained application files: ${recoveryPaths.join(', ')}` : ''}`;
      }
      else if (steamResult) error.message += ' Steam entry removal completed; local application files were kept.';
      throw error;
    } finally { busy = false; }
  }
  return {preview, uninstall};
}

module.exports = {createUninstall};
