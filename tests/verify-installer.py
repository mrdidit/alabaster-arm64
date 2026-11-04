#!/usr/bin/env python3
"""Verify embedded installer files against the manifest and current sources."""
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parents[1]
directory = Path(sys.argv[1]).resolve()
binary = directory / 'Alabaster-Dawn-Setup.arm64'
data = binary.read_bytes()
assert data[:6] == b'\x7fELF\x02\x01' and struct.unpack_from('<H', data, 18)[0] == 183
symbols = {}
for line in subprocess.check_output(['nm', '-P', str(binary)], text=True).splitlines():
    parts = line.split()
    if parts[0] in ('_binary_payload_tar_gz_start', '_binary_payload_tar_gz_end'):
        symbols[parts[0]] = int(parts[2], 16)
start, end = (symbols['_binary_payload_tar_gz_' + name] for name in ('start', 'end'))
phoff = struct.unpack_from('<Q', data, 32)[0]
phsize, phcount = struct.unpack_from('<HH', data, 54)
payload = None
for index in range(phcount):
    kind, _, offset, virtual, _, size, _, _ = struct.unpack_from('<IIQQQQQQ', data, phoff + index * phsize)
    if kind == 1 and virtual <= start < end <= virtual + size:
        payload = data[offset + start - virtual:offset + end - virtual]
        break
assert payload is not None, 'Embedded payload is outside a file-backed load segment'
digest = lambda value: hashlib.sha256(value).hexdigest()
manifest = json.loads((directory / 'payload-files.json').read_text())
with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
    members = archive.getmembers()
    assert len(members) == len(manifest) and {m.name for m in members} == set(manifest)
    for member in members:
        assert member.isfile(), member.name
        content = archive.extractfile(member).read()
        assert digest(content) == manifest[member.name], member.name
        name = member.name.removeprefix('app/')
        if name.startswith('menu/') or name.endswith('.cjs') or name == 'launcher.c':
            assert content == (root / 'src' / name).read_bytes(), member.name
for line in (directory / 'SHA256SUMS').read_text().splitlines():
    expected, name = line.split()
    assert digest((directory / name).read_bytes()) == expected, name
with tarfile.open(directory / 'Alabaster-Dawn-Setup-linux-arm64.tar.gz', mode='r:gz') as archive:
    assert archive.getnames() == [binary.name]
    assert archive.extractfile(binary.name).read() == data
result = {'files': len(manifest), 'sha256': digest(data), 'payload_sha256': digest(payload),
          'payload_verified': True, 'current_sources_match': True, 'archive_matches': True}
(directory / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
