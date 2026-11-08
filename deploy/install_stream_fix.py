"""在指定服务器以 sudo 执行；失败时恢复本次备份，不触碰 data。"""
import json
import os
import re
import shutil
import subprocess
import tarfile
import time
import urllib.request
from datetime import datetime
from pathlib import Path


root = Path('/opt/ai-gallery')
if os.geteuid() != 0:
  raise SystemExit('Run with sudo')
pid = subprocess.check_output(['systemctl', 'show', 'ai-gallery.service', '-p', 'MainPID', '--value'], text=True).strip()
if pid != '0' and len(list(Path('/proc', pid, 'task').iterdir())) > 1:
  raise SystemExit('Active requests detected; no changes made. Retry when idle.')
backup = root / 'backups' / ('stream-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(parents=True, mode=0o700)
os.chmod(backup, 0o700)
shutil.copy2(root / '.env', backup / '.env')
shutil.copy2(root / 'server.py', backup / 'server.py')
stage = backup / 'new-app'
stage.mkdir()
with tarfile.open('/tmp/ai-gallery-stream-20260904.tar.gz') as archive:
  for member in archive.getmembers():
    target = (stage / member.name).resolve()
    if not target.is_relative_to(stage.resolve()) or member.issym() or member.islnk():
      raise RuntimeError('Unsafe archive member')
  archive.extractall(stage, filter='data')
config = (root / '.env').read_text()
for key, value in [('AI_GALLERY_STREAM_IMAGES', 'true'), ('AI_GALLERY_PARTIAL_IMAGES', '1')]:
  config = re.sub(r'^' + key + r'=.*\n?', '', config, flags=re.MULTILINE)
  config = config.rstrip('\n') + '\n' + key + '=' + value + '\n'
switched = False
try:
  # 临近切换再次检查，避免中断员工正在生成的任务。
  if pid != '0' and len(list(Path('/proc', pid, 'task').iterdir())) > 1:
    raise RuntimeError('Active request appeared; abort deployment')
  subprocess.run(['systemctl', 'stop', 'ai-gallery.service'], check=True)
  os.replace(root / 'app', backup / 'app')
  switched = True
  os.replace(stage, root / 'app')
  shutil.copy2('/tmp/ai_gallery_server.py', root / 'server.py')
  (root / '.env').write_text(config)
  os.chmod(root / '.env', 0o600)
  subprocess.run(['systemctl', 'start', 'ai-gallery.service'], check=True)
  opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
  for attempt in range(20):
    try:
      with opener.open('http://127.0.0.1:5731/api/runtime-config', timeout=2) as response:
        runtime = json.load(response)
      assert runtime['streamImages'] is True
      print(json.dumps({'deployed': True, 'runtime': runtime, 'backup': str(backup)}))
      break
    except Exception:
      if attempt == 19:
        raise
      time.sleep(0.5)
except Exception:
  if switched:
    subprocess.run(['systemctl', 'stop', 'ai-gallery.service'], check=True)
    if (root / 'app').exists():
      os.replace(root / 'app', backup / 'failed-app')
    os.replace(backup / 'app', root / 'app')
    shutil.copy2(backup / 'server.py', root / 'server.py')
    shutil.copy2(backup / '.env', root / '.env')
    subprocess.run(['systemctl', 'start', 'ai-gallery.service'], check=True)
    print('Deployment failed; previous version restored.')
  raise
