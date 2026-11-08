#!/usr/bin/env python3
import hashlib
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
UPSTREAM_URL = os.environ.get('AI_GALLERY_API_URL', '').rstrip('/')
UPSTREAM_KEY = os.environ.get('AI_GALLERY_API_KEY', '')
UPSTREAM_MODEL = os.environ.get('AI_GALLERY_MODEL', 'gpt-image-2-all').strip()
STREAM_IMAGES = os.environ.get('AI_GALLERY_STREAM_IMAGES', 'false').lower() == 'true'
PARTIAL_IMAGES = max(0, min(3, int(os.environ.get('AI_GALLERY_PARTIAL_IMAGES', '1'))))
HOST = os.environ.get('AI_GALLERY_HOST', '0.0.0.0')
PORT = int(os.environ.get('AI_GALLERY_PORT', '5731'))
MAX_BODY = 80 * 1024 * 1024


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


def replace_multipart_field(body, content_type, field_name, value):
  boundary_match = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type, re.IGNORECASE)
  if not boundary_match:
    return body, False
  boundary = (boundary_match.group(1) or boundary_match.group(2)).strip().encode('latin1')
  delimiter = b'--' + boundary
  parts = body.split(delimiter)
  field_marker = ('name="' + field_name + '"').encode('utf-8')
  replaced = False
  for index, part in enumerate(parts):
    header_end = part.find(b'\r\n\r\n')
    if header_end < 0 or field_marker not in part[:header_end]:
      continue
    value_start = header_end + 4
    value_end = len(part) - 2 if part.endswith(b'\r\n') else len(part)
    parts[index] = part[:value_start] + value.encode('utf-8') + part[value_end:]
    replaced = True
  if not replaced and body.rstrip().endswith(delimiter + b'--'):
    closing = body.rfind(delimiter + b'--')
    field = delimiter + b'\r\nContent-Disposition: form-data; ' + field_marker + b'\r\n\r\n' + value.encode('utf-8') + b'\r\n'
    return body[:closing] + field + body[closing:], True
  return delimiter.join(parts), replaced


def proxy_image_urls(payload, origin):
  # SSE 按事件处理，沿用 JSON 图片代理，不能等整个生成结束才改写。
  if isinstance(payload, dict):
    for key, value in payload.items():
      if key == 'url' and isinstance(value, str) and value.startswith('https://'):
        payload[key] = origin + '/api/image-fetch?url=' + urllib.parse.quote(value, safe='')
      elif isinstance(value, (dict, list)):
        proxy_image_urls(value, origin)
  elif isinstance(payload, list):
    for value in payload:
      proxy_image_urls(value, origin)
  return payload


def rewrite_sse_event(block, origin):
  lines = block.decode('utf-8').splitlines()
  data = '\n'.join(line[5:].lstrip(' ') for line in lines if line.startswith('data:'))
  if not data or data.strip() == '[DONE]':
    return block + b'\n\n'
  payload = json.loads(data)
  proxy_image_urls(payload, origin)
  # 保留 event/id/retry/注释；仅合并单个完整事件的 data 行。
  metadata = [line for line in lines if not line.startswith('data:')]
  return ('\n'.join(metadata + ['data: ' + json_bytes(payload).decode('utf-8')]) + '\n\n').encode('utf-8')


class Handler(SimpleHTTPRequestHandler):
  server_version = 'AICompanyGallery/1.0'

  def __init__(self, *args, **kwargs):
    super().__init__(*args, directory=str(APP_DIR), **kwargs)

  def log_message(self, fmt, *args):
    sys.stdout.write('%s %s\n' % (self.log_date_time_string(), fmt % args))
    sys.stdout.flush()

  def send_json(self, status, value):
    body = json_bytes(value)
    self.send_response(status)
    self.send_header('Content-Type', 'application/json; charset=utf-8')
    self.send_header('Content-Length', str(len(body)))
    self.send_header('Cache-Control', 'no-store')
    self.end_headers()
    self.wfile.write(body)

  def read_body(self):
    length = int(self.headers.get('Content-Length', '0'))
    if length > MAX_BODY:
      raise ValueError('request body too large')
    return self.rfile.read(length)

  def do_GET(self):
    parsed = urllib.parse.urlsplit(self.path)
    if parsed.path == '/api/health':
      return self.send_json(200, {'ok': True, 'service': 'ai-gallery'})
    if parsed.path == '/api/runtime-config':
      return self.send_json(200, {'model': UPSTREAM_MODEL, 'streamImages': STREAM_IMAGES, 'streamPartialImages': PARTIAL_IMAGES})
    if parsed.path == '/api/users':
      return self.handle_users()
    if parsed.path == '/api/gallery':
      return self.handle_gallery(parsed.query)
    if parsed.path == '/api/image-fetch':
      return self.handle_image_fetch(parsed.query)
    if parsed.path.startswith('/api-proxy/'):
      return self.handle_proxy()
    if parsed.path.startswith('/media/'):
      return self.handle_media(parsed.path[7:])
    return super().do_GET()

  def do_POST(self):
    parsed = urllib.parse.urlsplit(self.path)
    try:
      if parsed.path == '/api/users/resolve':
        return self.handle_resolve_user()
      if parsed.path == '/api/gallery':
        return self.handle_archive()
      if parsed.path.startswith('/api-proxy/'):
        return self.handle_proxy()
      return self.send_json(404, {'error': 'not found'})
    except ValueError as err:
      return self.send_json(400, {'error': str(err)})
    except Exception as err:
      self.log_error('request failed: %s', err)
      return self.send_json(500, {'error': 'server error'})

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

  def handle_image_fetch(self, query):
    url = urllib.parse.parse_qs(query).get('url', [''])[0]
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname:
      return self.send_json(400, {'error': 'invalid image URL'})
    try:
      request = urllib.request.Request(url, headers={'User-Agent': 'AICompanyGallery/1.0'})
      with urllib.request.urlopen(request, timeout=120) as response:
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
          return self.send_json(413, {'error': 'image too large'})
        self.send_response(200)
        self.send_header('Content-Type', response.headers.get_content_type())
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)
    except urllib.error.URLError as err:
      self.send_json(502, {'error': f'image fetch failed: {err.reason}'})

  def handle_proxy(self):
    started = time.monotonic()
    request_id = uuid.uuid4().hex
    def trace(phase, **fields):
      print(json_bytes({'event': 'api_proxy', 'request_id': request_id, 'phase': phase,
                        'elapsed_ms': round((time.monotonic() - started) * 1000), **fields}).decode('utf-8'), flush=True)
    if not UPSTREAM_URL or not UPSTREAM_KEY or not UPSTREAM_MODEL:
      return self.send_json(503, {'error': 'upstream API is not configured'})
    parsed = urllib.parse.urlsplit(self.path)
    suffix = parsed.path[len('/api-proxy/'):].lstrip('/')
    is_image = suffix in ('images/generations', 'images/edits')
    trace('start', endpoint=suffix, model=UPSTREAM_MODEL, stream=STREAM_IMAGES if is_image else None,
          request_bytes=int(self.headers.get('Content-Length', '0')))
    url = UPSTREAM_URL + '/' + suffix
    if parsed.query:
      url += '?' + parsed.query
    body = self.read_body() if self.command in ('POST', 'PUT', 'PATCH') else None
    trace('request_body_read')
    content_type = self.headers.get('Content-Type', '')
    if body and content_type.startswith('application/json'):
      payload = json.loads(body.decode('utf-8'))
      if suffix in ('images/generations', 'images/edits'):
        if not isinstance(payload, dict):
          raise ValueError('image request body must be a JSON object')
        payload['model'] = UPSTREAM_MODEL
        payload['response_format'] = 'url'
        payload['stream'] = STREAM_IMAGES
        if STREAM_IMAGES:
          payload['partial_images'] = PARTIAL_IMAGES
        else:
          payload.pop('partial_images', None)
        trace('request_parameters', n=payload.get('n', 1))
      body = json_bytes(payload)
    elif body and content_type.startswith('multipart/form-data') and suffix == 'images/edits':
      body, replaced = replace_multipart_field(body, content_type, 'model', UPSTREAM_MODEL)
      if not replaced:
        raise ValueError('image request is missing the model field')
      for field, value in [('stream', str(STREAM_IMAGES).lower()), ('response_format', 'url'),
                           ('partial_images', str(PARTIAL_IMAGES if STREAM_IMAGES else 0))]:
        body, replaced = replace_multipart_field(body, content_type, field, value)
        if not replaced:
          raise ValueError('invalid multipart image request')
    headers = {
      'Authorization': 'Bearer ' + UPSTREAM_KEY,
      'Accept': 'text/event-stream, application/json' if is_image and STREAM_IMAGES else 'application/json',
      'Accept-Encoding': 'identity',
      'X-Request-ID': request_id,
      'User-Agent': 'AICompanyGallery/1.0',
    }
    if content_type:
      headers['Content-Type'] = content_type
    request = urllib.request.Request(url, data=body, headers=headers, method=self.command)
    streaming = False
    status = None
    trace('upstream_open_start', forwarded_bytes=len(body) if body else 0)
    try:
      with urllib.request.urlopen(request, timeout=600) as response:
        status = response.status
        response_type = response.headers.get('Content-Type', 'application/octet-stream')
        trace('upstream_headers', status=status, content_type=response_type,
              cf_ray=response.headers.get('CF-Ray'), upstream_request_id=response.headers.get('X-Request-ID'))
        origin = 'http://' + self.headers.get('Host', f'127.0.0.1:{PORT}')
        if 'text/event-stream' in response_type.lower():
          self.send_response(status)
          self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
          self.send_header('Cache-Control', 'no-store, no-transform')
          self.send_header('X-Accel-Buffering', 'no')
          self.send_header('X-Request-ID', request_id)
          self.send_header('Connection', 'close')
          self.end_headers()
          self.wfile.flush()
          self.close_connection = True
          streaming = True
          buffer = b''
          chunks = 0
          events = 0
          last_chunk = time.monotonic()
          max_gap = 0
          while True:
            chunk = response.read1(16384)
            now = time.monotonic()
            max_gap = max(max_gap, now - last_chunk)
            last_chunk = now
            if not chunk:
              break
            chunks += 1
            if chunks == 1:
              trace('upstream_first_chunk')
            buffer += chunk
            separator = re.search(rb'\r?\n\r?\n', buffer)
            while separator:
              event = buffer[:separator.start()]
              buffer = buffer[separator.end():]
              self.wfile.write(rewrite_sse_event(event, origin))
              self.wfile.flush()
              events += 1
              if events == 1:
                trace('downstream_first_event')
              separator = re.search(rb'\r?\n\r?\n', buffer)
            if len(buffer) > MAX_BODY:
              raise ValueError('SSE event too large')
          if buffer.strip():
            self.wfile.write(rewrite_sse_event(buffer, origin))
            self.wfile.flush()
          trace('stream_complete', chunks=chunks, events=events, max_chunk_gap_ms=round(max_gap * 1000))
          return
        response_body = response.read()
        trace('upstream_body_complete', response_bytes=len(response_body), nonstream_fallback=is_image and STREAM_IMAGES)
        if response_type.startswith('application/json'):
          payload = json.loads(response_body.decode('utf-8'))
          proxy_image_urls(payload, origin)
          response_body = json_bytes(payload)
          response_type = 'application/json; charset=utf-8'
        self.send_response(response.status)
        self.send_header('Content-Type', response_type)
        self.send_header('Content-Length', str(len(response_body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Request-ID', request_id)
        self.end_headers()
        self.wfile.write(response_body)
    except urllib.error.HTTPError as err:
      status = err.code
      trace('upstream_http_error', status=status, cf_ray=err.headers.get('CF-Ray'),
            upstream_request_id=err.headers.get('X-Request-ID'))
      response_body = err.read()
      self.send_response(err.code)
      self.send_header('Content-Type', err.headers.get('Content-Type', 'application/json'))
      self.send_header('Content-Length', str(len(response_body)))
      self.send_header('X-Request-ID', request_id)
      if err.headers.get('CF-Ray'):
        self.send_header('CF-Ray', err.headers['CF-Ray'])
      self.end_headers()
      self.wfile.write(response_body)
    except (BrokenPipeError, ConnectionResetError):
      trace('client_disconnected')
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
      trace('transport_error', error_type=type(err).__name__)
      message = '上游连接或流式响应异常，请凭请求编号排查；请勿直接重复提交，以免重复计费。'
      if streaming:
        try:
          self.wfile.write(b'data: ' + json_bytes({'type': 'error', 'error': {'message': message + ' ' + request_id}}) + b'\n\n')
          self.wfile.flush()
        except OSError:
          pass
      else:
        self.send_json(502, {'error': message, 'request_id': request_id})
    finally:
      trace('end', status=status)


if __name__ == '__main__':
  init_storage()
  print(f'AI Gallery listening on {HOST}:{PORT}', flush=True)
  ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
