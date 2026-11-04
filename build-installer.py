#!/usr/bin/env python3
"""Build the Linux ARM64 setup executable without downloading game/runtime data."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent


def archive_bytes(entries):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for name, data, mode in sorted(entries):
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = mode
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='alabaster-setup-build-') as temporary:
        stage = Path(temporary)
        launcher = stage/'alabaster-dawn.arm64'
        common = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fstack-protector-strong',
                  '-D_FORTIFY_SOURCE=2', '-Wl,-z,relro,-z,now,-z,noexecstack', '-Wl,--build-id=none']
        subprocess.run(['cc', *common, str(ROOT/'src/launcher.c'), '-o', str(launcher)], check=True)
        header = launcher.read_bytes()[:20]
        if header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != 183:
            raise RuntimeError('Build this installer with a Linux ARM64 compiler.')
        manifest = json.loads((ROOT/'package.json').read_text())
        manifest.update(name='Alabaster Dawn ARM64', main='menu/index.html')
        manifest['window'].update(title='Alabaster Dawn', icon='menu/assets/logo.png')
        manifest['icons'] = {'256': 'menu/assets/logo.png'}
        entries = [('alabaster-dawn.arm64', launcher.read_bytes(), 0o755),
                   ('app/package.json', (json.dumps(manifest, indent=2)+'\n').encode(), 0o644)]
        for name in ['launcher.c', 'setup.cjs', 'save-transfer.cjs', 'steam-cloud.cjs', 'cloud-sync.cjs', 'steam-shortcut.cjs', 'uninstall.cjs', 'controller-emulation.cjs']:
            entries.append((name, (ROOT/'src'/name).read_bytes(), 0o644))
        for path in sorted((ROOT/'src/menu').rglob('*')):
            if path.is_symlink():
                raise RuntimeError(f'Payload assets must be regular files: {path}')
            if path.is_file():
                name = path.relative_to(ROOT/'src').as_posix()
                entries.extend([(name, path.read_bytes(), 0o644), ('app/'+name, path.read_bytes(), 0o644)])
        payload = archive_bytes(entries)
        (stage/'payload.tar.gz').write_bytes(payload)
        subprocess.run(['ld', '-r', '-b', 'binary', 'payload.tar.gz', '-o', 'payload.o'], cwd=stage, check=True)
        subprocess.run(['objcopy', '--rename-section', '.data=.rodata,alloc,load,readonly,data,contents',
                        'payload.o'], cwd=stage, check=True)
        gtk = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'gtk+-3.0'], text=True))
        binary = stage/'Alabaster-Dawn-Setup.arm64'
        payload_hash = hashlib.sha256(payload).hexdigest()
        subprocess.run(['cc', *common, f'-DPAYLOAD_SHA256="{payload_hash}"', str(ROOT/'src/bootstrap.c'),
                        str(stage/'payload.o'), *gtk, '-o', str(binary)], check=True)
        final = binary.read_bytes()
        (output/binary.name).write_bytes(final)
        (output/binary.name).chmod(0o755)
        package = output/'Alabaster-Dawn-Setup-linux-arm64.tar.gz'
        package.write_bytes(archive_bytes([(binary.name, final, 0o755)]))
        hashes = {binary.name: hashlib.sha256(final).hexdigest(), package.name: hashlib.sha256(package.read_bytes()).hexdigest()}
        (output/'SHA256SUMS').write_text(''.join(f'{value}  {name}\n' for name, value in hashes.items()))
        (output/'payload-files.json').write_text(json.dumps({name: hashlib.sha256(data).hexdigest() for name, data, _ in entries}, indent=2)+'\n')
        print(json.dumps({'output': str(output), 'sha256': hashes, 'payload_sha256': payload_hash}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'dist')
    build(parser.parse_args().output.resolve())
