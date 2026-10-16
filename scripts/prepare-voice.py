"""Prepare pinned official runtime/model dependencies; no credentials or user audio."""
from pathlib import Path
import hashlib,json,shutil,urllib.request,sys
sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parents[1]
config=json.loads((root/'data/voice-runtime.json').read_text(encoding='utf-8'))
vendor=root/'.local/vendor/sherpa'
assets=root/'.local/android-voice/voice'
vendor.mkdir(parents=True,exist_ok=True);assets.mkdir(parents=True,exist_ok=True)
def fetch(url,path,expected):
    path.parent.mkdir(parents=True,exist_ok=True)
    if not path.exists():urllib.request.urlretrieve(url,path)
    if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise RuntimeError('依赖校验失败：'+path.name)
fetch(config['aar']['url'],vendor/config['aar']['file'],config['aar']['sha256'])
for item in config['files']:
    source=vendor/'model'/item['name']
    fetch('https://huggingface.co/'+config['model']+'/resolve/'+config['revision']+'/'+item['name'],source,item['sha256'])
    target=assets/item['name']
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest()!=item['sha256']:shutil.copyfile(source,target)
print('本地中文语音依赖已准备并校验')
