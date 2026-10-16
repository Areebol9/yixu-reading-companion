"""Fetch a pinned, verified source archive; no remote build scripts are executed."""
from pathlib import Path
import hashlib, shutil, tarfile, urllib.request

root = Path(__file__).resolve().parents[1]
version = '0.17.0'
digest = '559bc4c420475e55c7ab4510adbc562f55d7524d75e8e89d79ce4bb02f5687d9'
folder = root / '.local/vendor/quickjs'
folder.mkdir(parents=True, exist_ok=True)
archive = folder / f'v{version}.tar.gz'
if not archive.exists():
    urllib.request.urlretrieve(f'https://github.com/quickjs-ng/quickjs/archive/refs/tags/v{version}.tar.gz', archive)
if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
    raise RuntimeError('QuickJS source archive hash mismatch')
source = folder / f'quickjs-{version}'
if not (source / 'quickjs.c').exists():
    with tarfile.open(archive) as package:
        package.extractall(folder, filter='data')
with tarfile.open(archive) as package:
    for member in package:
        if not member.isfile() or not (member.name.endswith(('.c', '.h')) or member.name.endswith('/LICENSE')):
            continue
        checked = folder / member.name
        if not checked.is_relative_to(folder) or not checked.exists() or checked.read_bytes() != package.extractfile(member).read():
            raise RuntimeError('QuickJS source cache differs from the verified archive: ' + member.name)
assets = root / '.local/native-license-assets/licenses'
assets.mkdir(parents=True, exist_ok=True)
shutil.copyfile(source / 'LICENSE', assets / 'QuickJS-NG.txt')
print('QuickJS-NG 0.17.0 source verified; license included')
