#!/usr/bin/env python3
"""公司图库与 Garden 客户端网关；生图执行仅在 Garden。

本服务保留原公司图库数据库和媒体，转发通用任务及 Garden 登录态。
可选文本代理只允许 Responses 文本/函数工具，禁止内置生图工具。
"""
import base64
import hashlib
import http.client
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


APP_DIR = Path(os.environ.get('AI_GALLERY_APP_DIR', '/opt/ai-gallery/app')).resolve()
DATA_DIR = Path(os.environ.get('AI_GALLERY_DATA_DIR', '/opt/ai-gallery/data')).resolve()
DB_PATH = DATA_DIR / 'gallery.db'
GARDEN_API_URL = os.environ.get('GARDEN_API_URL', '').rstrip('/')
TEXT_API_URL = os.environ.get('AI_GALLERY_TEXT_API_URL', '').rstrip('/')
TEXT_API_KEY = os.environ.get('AI_GALLERY_TEXT_API_KEY', '')
HOST = os.environ.get('AI_GALLERY_HOST', '0.0.0.0')
PORT = int(os.environ.get('AI_GALLERY_PORT', '5731'))
MAX_BODY = 80 * 1024 * 1024
UPSTREAM_USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                       '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

class ClientInputError(ValueError):
  pass


def is_garden_path(path):
  return (path in ('/api/image-jobs', '/api/image-capabilities', '/api/identity')
          or path.startswith(('/api/image-jobs/', '/api/auth/')))


def now_iso():
  return datetime.now(timezone.utc).isoformat(timespec='seconds')


def normalize_prompt(value):
  text = unicodedata.normalize('NFKC', str(value or '')).lower()
  text = re.sub(r'[\s\u3000]+', ' ', text)
  text = re.sub(r'[，。！？；：、“”‘’（）【】]', lambda m: {
    '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':',
    '、': ',', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(',
    '）': ')', '【': '[', '】': ']',
  }[m.group(0)], text)
  return text.strip()


def connect():
  db = sqlite3.connect(DB_PATH)
  db.row_factory = sqlite3.Row
  db.execute('PRAGMA journal_mode=WAL')
  db.execute('PRAGMA foreign_keys=ON')
  db.execute('PRAGMA busy_timeout=5000')
  return db


def init_storage():
  for name in ('images', 'thumbnails', 'references'):
    (DATA_DIR / name).mkdir(parents=True, exist_ok=True)
  with connect() as db:
    db.executescript('''
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        avatar TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_identity ON users(nickname, avatar);

      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        nickname_snapshot TEXT NOT NULL,
        avatar_snapshot TEXT NOT NULL,
        prompt_raw TEXT NOT NULL,
        prompt_normalized TEXT NOT NULL,
        image_path TEXT NOT NULL,
        thumbnail_path TEXT NOT NULL,
        reference_images TEXT NOT NULL DEFAULT '[]',
        sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        is_featured INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_generations_created ON generations(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generations_prompt ON generations(prompt_normalized);
    ''')


def json_bytes(value):
  return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def safe_media_path(relative):
  target = (DATA_DIR / relative.lstrip('/')).resolve()
  if target != DATA_DIR and DATA_DIR not in target.parents:
    raise ValueError('invalid media path')
  return target


def parse_multipart(headers, body):
  raw = b'Content-Type: ' + headers.get('Content-Type', '').encode('latin1') + b'\r\nMIME-Version: 1.0\r\n\r\n' + body
  message = BytesParser(policy=default).parsebytes(raw)
  fields = {}
  files = {}
  for part in message.iter_parts():
    name = part.get_param('name', header='content-disposition')
    if not name:
      continue
    payload = part.get_payload(decode=True) or b''
    filename = part.get_filename()
    if filename:
      files.setdefault(name, []).append({
        'filename': filename,
        'content_type': part.get_content_type(),
        'data': payload,
      })
    else:
      fields[name] = payload.decode('utf-8')
  return fields, files


class Handler(SimpleHTTPRequestHandler):
  server_version = 'AICompanyGallery/1.1'

  def __init__(self, *args, **kwargs):
    super().__init__(*args, directory=str(APP_DIR), **kwargs)

  def end_headers(self):
    self.send_header('Referrer-Policy', 'no-referrer')
    super().end_headers()

  def log_message(self, fmt, *args):
    sys.stdout.write('%s %s\n' % (self.log_date_time_string(), fmt % args))
    sys.stdout.flush()

  def send_json(self, status, value, extra_headers=None):
    body = json_bytes(value)
    self.send_response(status)
    self.send_header('Content-Type', 'application/json; charset=utf-8')
    self.send_header('Content-Length', str(len(body)))
    self.send_header('Cache-Control', 'no-store')
    for name, value in (extra_headers or {}).items():
      self.send_header(name, value)
    self.end_headers()
    self.wfile.write(body)

  def read_body(self):
    length = int(self.headers.get('Content-Length', '0'))
    if length > MAX_BODY:
      raise ValueError('request body too large')
    return self.rfile.read(length)

  def do_GET(self):
    parsed = urllib.parse.urlsplit(self.path)
    try:
      if is_garden_path(parsed.path):
        return self.handle_garden()
      if parsed.path == '/api/health':
        return self.send_json(200, {'ok': True, 'service': 'ai-gallery'})
      if parsed.path == '/api/runtime-config':
        return self.handle_runtime_config()
      if parsed.path == '/api/users':
        return self.handle_users()
      if parsed.path == '/api/gallery':
        return self.handle_gallery(parsed.query)
      if parsed.path == '/api/image-fetch':
        return self.send_json(410, {'detail': '远程图片抓取接口已停用，请使用 Garden 任务结果接口'})
      if parsed.path.startswith('/api-proxy/'):
        return self.handle_proxy()
      if parsed.path.startswith('/media/'):
        return self.handle_media(parsed.path[7:])
      return super().do_GET()
    except ClientInputError as err:
      return self.send_json(400, {'error': str(err)})

  def do_POST(self):
    parsed = urllib.parse.urlsplit(self.path)
    try:
      if is_garden_path(parsed.path):
        return self.handle_garden()
      if parsed.path == '/api/users/resolve':
        return self.handle_resolve_user()
      if parsed.path == '/api/gallery':
        return self.handle_archive()
      if parsed.path.startswith('/api-proxy/'):
        return self.handle_proxy()
      return self.send_json(404, {'error': 'not found'})
    except ClientInputError as err:
      return self.send_json(400, {'error': str(err)})
    except ValueError as err:
      return self.send_json(400, {'error': str(err)})
    except Exception as err:
      self.log_error('request failed: %s', err)
      return self.send_json(500, {'error': 'server error'})

  def handle_runtime_config(self):
    return self.send_json(200, {'model': 'garden-managed', 'streamImages': False, 'streamPartialImages': 0})

  def handle_users(self):
    with connect() as db:
      rows = db.execute('''
        SELECT u.id, u.nickname, u.avatar, u.last_seen, COUNT(g.id) AS generation_count
        FROM users u LEFT JOIN generations g ON g.user_id = u.id
        GROUP BY u.id ORDER BY generation_count DESC, u.nickname
      ''').fetchall()
    self.send_json(200, {'items': [dict(row) for row in rows]})

  def handle_resolve_user(self):
    payload = json.loads(self.read_body().decode('utf-8'))
    nickname = str(payload.get('nickname', '')).strip()
    avatar = str(payload.get('avatar', '')).strip()
    selected_id = str(payload.get('user_id', '')).strip()
    if not nickname or len(nickname) > 32:
      raise ValueError('昵称应为 1 到 32 个字符')
    if not avatar or len(avatar) > 16:
      raise ValueError('请选择 Emoji 头像')

    stamp = now_iso()
    with connect() as db:
      if selected_id:
        row = db.execute('SELECT * FROM users WHERE id=? AND nickname=? AND avatar=?', (selected_id, nickname, avatar)).fetchone()
        if not row:
          raise ValueError('用户身份不存在')
        db.execute('UPDATE users SET last_seen=? WHERE id=?', (stamp, selected_id))
        return self.send_json(200, {'status': 'resolved', 'user': dict(row)})

      rows = db.execute('SELECT * FROM users WHERE nickname=? AND avatar=? ORDER BY created_at', (nickname, avatar)).fetchall()
      if len(rows) > 1:
        return self.send_json(200, {'status': 'ambiguous', 'candidates': [dict(row) for row in rows]})
      if len(rows) == 1:
        db.execute('UPDATE users SET last_seen=? WHERE id=?', (stamp, rows[0]['id']))
        return self.send_json(200, {'status': 'resolved', 'user': dict(rows[0])})

      user = {'id': str(uuid.uuid4()), 'nickname': nickname, 'avatar': avatar, 'created_at': stamp, 'last_seen': stamp}
      db.execute('INSERT INTO users(id,nickname,avatar,created_at,last_seen) VALUES(:id,:nickname,:avatar,:created_at,:last_seen)', user)
      return self.send_json(201, {'status': 'created', 'user': user})

  def handle_gallery(self, query):
    params = urllib.parse.parse_qs(query)
    search = normalize_prompt(params.get('search', [''])[0])
    user_id = params.get('user_id', [''])[0]
    limit = min(100, max(1, int(params.get('limit', ['40'])[0])))
    offset = max(0, int(params.get('offset', ['0'])[0]))
    where = []
    values = []
    if search:
      where.append('prompt_normalized LIKE ?')
      values.append('%' + search + '%')
    if user_id:
      where.append('user_id=?')
      values.append(user_id)
    clause = (' WHERE ' + ' AND '.join(where)) if where else ''
    with connect() as db:
      rows = db.execute(
        'SELECT * FROM generations' + clause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
        (*values, limit + 1, offset),
      ).fetchall()
    has_more = len(rows) > limit
    items = []
    for row in rows[:limit]:
      item = dict(row)
      item['image_url'] = '/media/' + item.pop('image_path')
      item['thumbnail_url'] = '/media/' + item.pop('thumbnail_path')
      item['reference_images'] = ['/media/' + path for path in json.loads(item['reference_images'])]
      item['is_featured'] = bool(item['is_featured'])
      items.append(item)
    self.send_json(200, {'items': items, 'has_more': has_more, 'next_offset': offset + len(items)})

  def handle_archive(self):
    fields, files = parse_multipart(self.headers, self.read_body())
    metadata = json.loads(fields.get('metadata', '{}'))
    required = ('user_id', 'prompt_raw')
    if any(not str(metadata.get(key, '')).strip() for key in required):
      raise ValueError('归档元数据不完整')
    if not files.get('image') or not files.get('thumbnail'):
      raise ValueError('缺少主图或缩略图')

    image_sha256 = hashlib.sha256(files['image'][0]['data']).hexdigest()
    with connect() as db:
      existing = db.execute('SELECT id FROM generations WHERE sha256=?', (image_sha256,)).fetchone()
      if existing:
        return self.send_json(200, {'status': 'duplicate', 'id': existing['id']})
      user = db.execute('SELECT * FROM users WHERE id=?', (metadata['user_id'],)).fetchone()
      if not user:
        raise ValueError('用户身份不存在，请重新设置')

      generation_id = str(uuid.uuid4())
      stamp = now_iso()
      date = datetime.now().strftime('%Y/%m')
      image_rel = f'images/{date}/{generation_id}.webp'
      thumb_rel = f'thumbnails/{date}/{generation_id}.webp'
      references = []
      image_path = safe_media_path(image_rel)
      thumb_path = safe_media_path(thumb_rel)
      image_path.parent.mkdir(parents=True, exist_ok=True)
      thumb_path.parent.mkdir(parents=True, exist_ok=True)
      image_path.write_bytes(files['image'][0]['data'])
      thumb_path.write_bytes(files['thumbnail'][0]['data'])
      try:
        for index, item in enumerate(files.get('references', [])):
          ref_rel = f'references/{date}/{generation_id}-{index + 1}.webp'
          ref_path = safe_media_path(ref_rel)
          ref_path.parent.mkdir(parents=True, exist_ok=True)
          ref_path.write_bytes(item['data'])
          references.append(ref_rel)
        db.execute('''
          INSERT INTO generations(
            id,user_id,nickname_snapshot,avatar_snapshot,prompt_raw,prompt_normalized,
            image_path,thumbnail_path,reference_images,sha256,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ''', (
          generation_id, user['id'], user['nickname'], user['avatar'],
          str(metadata['prompt_raw']), normalize_prompt(metadata['prompt_raw']),
          image_rel, thumb_rel, json.dumps(references), image_sha256, stamp,
        ))
      except Exception:
        image_path.unlink(missing_ok=True)
        thumb_path.unlink(missing_ok=True)
        for rel in references:
          safe_media_path(rel).unlink(missing_ok=True)
        raise
    self.send_json(201, {'status': 'created', 'id': generation_id})

  def handle_media(self, relative):
    try:
      path = safe_media_path(relative)
    except ValueError:
      return self.send_error(404)
    if not path.is_file():
      return self.send_error(404)
    content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    self.send_response(200)
    self.send_header('Content-Type', content_type)
    self.send_header('Content-Length', str(path.stat().st_size))
    self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
    self.end_headers()
    with path.open('rb') as source:
      shutil.copyfileobj(source, self.wfile)

  def handle_garden(self):
    if not GARDEN_API_URL:
      return self.send_json(503, {'detail': '请配置 GARDEN_API_URL，生图任务只能由 Garden 执行'})
    body = self.read_body() if self.command == 'POST' else None
    headers = {name: self.headers[name] for name in ('Content-Type', 'Cookie', 'Accept') if self.headers.get(name)}
    self.forward_request(GARDEN_API_URL + self.path, body, headers)

  def handle_proxy(self):
    # 旧的 images 路径明确退役，避免旧前端或 CLI 绕过 Garden。
    path = urllib.parse.urlsplit(self.path).path
    if path != '/api-proxy/responses' or self.command != 'POST':
      return self.send_json(410, {'detail': '生图接口已迁移至 /api/image-jobs'})
    body = self.read_body()
    try:
      payload = json.loads(body)
    except ValueError:
      return self.send_json(400, {'detail': '请求体不是合法 JSON'})
    tools = payload.get('tools') if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or (tools is not None and not isinstance(tools, list)):
      return self.send_json(400, {'detail': '文本请求格式无效'})
    choice = payload.get('tool_choice')
    if isinstance(choice, dict) and choice.get('type') not in ('function', 'web_search', 'web_search_preview'):
      return self.send_json(422, {'detail': '文本代理不支持生图工具，请使用 Garden'})
    if any(not isinstance(t, dict) or t.get('type') not in ('function', 'web_search', 'web_search_preview') for t in tools or []):
      return self.send_json(422, {'detail': '文本代理不支持生图工具，请使用 Garden'})
    if not TEXT_API_URL:
      return self.send_json(503, {'detail': '请配置 Agent 文本 API，生图供应商配置由 Garden 管理'})
    base = TEXT_API_URL if TEXT_API_URL.endswith('/v1') else TEXT_API_URL + '/v1'
    headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TEXT_API_KEY}
    self.forward_request(base + '/responses', body, headers)

  def forward_request(self, url, body, headers):
    # 网关不重试 POST，不注入生图密钥；登录 Cookie 和 Set-Cookie 原样往返。
    request = urllib.request.Request(url, data=body, headers=headers, method=self.command)
    try:
      response = urllib.request.urlopen(request, timeout=600)
    except urllib.error.HTTPError as err:
      response = err
    except (urllib.error.URLError, TimeoutError, OSError):
      return self.send_json(502, {'detail': 'Garden 或文本服务暂时不可达，请稍后恢复查询'})
    with response:
      self.send_response(response.status)
      for name in ('Content-Type', 'Content-Length', 'Set-Cookie'):
        for value in response.headers.get_all(name, []):
          self.send_header(name, value)
      self.send_header('Cache-Control', 'no-store')
      self.send_header('Connection', 'close')
      self.end_headers()
      self.close_connection = True
      try:
        while chunk := response.read(65536):
          self.wfile.write(chunk)
          self.wfile.flush()
      except (BrokenPipeError, ConnectionResetError):
        self.log_message('客户端已断开，Garden 任务仍由服务端管理')


if __name__ == '__main__':
  init_storage()
  print(f'AI Gallery listening on {HOST}:{PORT}', flush=True)
  ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
