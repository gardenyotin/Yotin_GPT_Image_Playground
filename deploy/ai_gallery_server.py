#!/usr/bin/env python3
"""Company AI Image Gallery server — dual-provider edition (2026-10).

基于 2026-10-13 线上版扩展：
- 供应商配置改为 /opt/ai-gallery/ai-providers.json（mtime 热加载，改文件即生效）；
  文件缺失/损坏时回退旧 .env 单供应商，行为与旧版一致。
- 支持 openai_compat（Intelalloc 等 OpenAI 兼容中转；edits 支持 relay_json / multipart
  两种上游协议）与 seedream（火山 ARK /images/generations 单端点）两种接口规范。
- 代理层新增错误分类 + 自动重试 + 供应商间自动 failover（治"生图经常连不上"）：
  401/403 与明确 4xx 拒绝直接透传不再重试；408/429/5xx、建连失败、超时按退避重试，
  重试耗尽自动切到链上下一家；X-AI-Vendor 响应头标记实际服务的供应商。
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
PROVIDERS_CONFIG_PATH = Path(os.environ.get('AI_GALLERY_PROVIDERS_CONFIG',
                                             str(APP_DIR.parent / 'ai-providers.json')))
# 旧 .env 单供应商配置（回退安全网 + legacy 字段）
UPSTREAM_URL = os.environ.get('AI_GALLERY_API_URL', '').rstrip('/')
UPSTREAM_KEY = os.environ.get('AI_GALLERY_API_KEY', '')
UPSTREAM_MODEL = os.environ.get('AI_GALLERY_MODEL', 'gpt-image-2-all').strip()
IMAGE_CHANNEL = os.environ.get('AI_GALLERY_IMAGE_CHANNEL', 'generations').strip()
if IMAGE_CHANNEL not in ('generations', 'edits'):
  raise ValueError('AI_GALLERY_IMAGE_CHANNEL must be generations or edits')
STREAM_IMAGES = os.environ.get('AI_GALLERY_STREAM_IMAGES', 'false').lower() == 'true'
PARTIAL_IMAGES = max(0, min(3, int(os.environ.get('AI_GALLERY_PARTIAL_IMAGES', '1'))))
HOST = os.environ.get('AI_GALLERY_HOST', '0.0.0.0')
PORT = int(os.environ.get('AI_GALLERY_PORT', '5731'))
MAX_BODY = 80 * 1024 * 1024
UPSTREAM_USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                       '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

# ---------------- 供应商层缺省值 ----------------
DEFAULT_TIMEOUT_SECONDS = 300
DEFAULT_MAX_RETRIES = 2
RETRY_BACKOFF_SECONDS = (3, 6)
VALID_ADAPTERS = ('openai_compat', 'seedream')
VALID_EDITS_PROTOCOLS = ('relay_json', 'multipart')
IMAGE_SUFFIXES = ('images/generations', 'images/edits')
MAX_IMAGE_COUNT = 10
# 中转站前置 Cloudflare 拦截 urllib 默认 UA（403 error 1010），所有出站统一浏览器 UA。
SEEDREAM_USER_AGENT = UPSTREAM_USER_AGENT
SEEDREAM_DEFAULT_MODEL = 'doubao-seedream-4-0-250828'


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


# ============================ 供应商配置层 ============================
# ai-providers.json 结构（schema 1）：
# {
#   "schema": 1,
#   "active_vendor_id": "intelalloc",
#   "failover": true,
#   "vendors": [{
#     "vendor_id": "intelalloc", "adapter": "openai_compat",
#     "display_name": "intelalloc",
#     "base_url": "https://backend.intelalloc.com/v1",
#     "api_key": "sk-...", "model": "gpt-image-2.5-sunburst",
#     "edits_protocol": "relay_json",       # openai_compat 专用：relay_json=Intelalloc 私有 JSON
#                                           #   relay；multipart=标准 OpenAI multipart
#     "stream": true, "partial_images": 3,
#     "size": "auto", "quality": "auto", "output_format": "png", "background": "auto",
#     "response_format": "url",             # seedream 专用：url | b64_json
#     "timeout_seconds": 300, "max_retries": 2
#   }, ...]
# }
# 供应商按数组顺序组成 failover 链：active_vendor_id 排最前，其余按声明顺序。
# api_key 为空或缺 base_url 的条目在运行期跳过（记 trace 日志）。

_config_cache = {'stamp': None, 'value': None}


def _legacy_vendor():
  """旧 .env 单供应商（安全网：ai-providers.json 缺失/损坏/为空时启用，行为与旧版一致）。"""
  if not (UPSTREAM_URL and UPSTREAM_KEY and UPSTREAM_MODEL):
    return None
  return {
    'vendor_id': 'env-default', 'adapter': 'openai_compat', 'display_name': 'env-default',
    'base_url': UPSTREAM_URL, 'api_key': UPSTREAM_KEY, 'model': UPSTREAM_MODEL,
    'edits_protocol': 'relay_json' if IMAGE_CHANNEL == 'edits' else 'multipart',
    'stream': STREAM_IMAGES, 'partial_images': PARTIAL_IMAGES,
    'size': 'auto', 'quality': 'auto', 'output_format': 'png', 'background': 'auto',
    'response_format': 'url', 'timeout_seconds': DEFAULT_TIMEOUT_SECONDS,
    'max_retries': DEFAULT_MAX_RETRIES, 'user_agent': UPSTREAM_USER_AGENT,
  }


def _normalize_vendor(entry):
  if not isinstance(entry, dict):
    return None
  vendor_id = str(entry.get('vendor_id') or '').strip()
  adapter = str(entry.get('adapter') or '').strip()
  base_url = str(entry.get('base_url') or '').strip().rstrip('/')
  api_key = str(entry.get('api_key') or '').strip()
  if not vendor_id or adapter not in VALID_ADAPTERS or not base_url or not api_key:
    return None
  vendor = {
    'vendor_id': vendor_id, 'adapter': adapter,
    'display_name': str(entry.get('display_name') or vendor_id).strip(),
    'base_url': base_url, 'api_key': api_key,
    'model': str(entry.get('model') or '').strip(),
    'stream': bool(entry.get('stream', False)),
    'partial_images': max(0, min(3, int(entry.get('partial_images', 1) or 0))),
    'size': str(entry.get('size') or '').strip(),
    'quality': str(entry.get('quality') or '').strip(),
    'output_format': str(entry.get('output_format') or '').strip(),
    'background': str(entry.get('background') or '').strip(),
    'response_format': str(entry.get('response_format') or 'url').strip().lower(),
    'timeout_seconds': max(30, int(entry.get('timeout_seconds') or DEFAULT_TIMEOUT_SECONDS)),
    'max_retries': max(0, int(entry.get('max_retries', DEFAULT_MAX_RETRIES))),
    'user_agent': str(entry.get('user_agent') or UPSTREAM_USER_AGENT).strip(),
  }
  if vendor['adapter'] == 'openai_compat':
    protocol = str(entry.get('edits_protocol') or 'multipart').strip().lower()
    if protocol not in VALID_EDITS_PROTOCOLS:
      return None
    vendor['edits_protocol'] = protocol
    if not vendor['model']:
      return None
    if not vendor['size']:
      vendor['size'] = 'auto'
    if not vendor['quality']:
      vendor['quality'] = 'auto'
    if not vendor['output_format']:
      vendor['output_format'] = 'png'
    if not vendor['background']:
      vendor['background'] = 'auto'
  else:  # seedream
    if not vendor['model']:
      vendor['model'] = SEEDREAM_DEFAULT_MODEL
    vendor['stream'] = False  # ARK images 协议无流式
  return vendor


def load_provider_config():
  """mtime+size 热加载；损坏/缺失/空 → legacy env 单供应商（可能为 None=未配置）。"""
  try:
    stat = PROVIDERS_CONFIG_PATH.stat()
    stamp = (stat.st_mtime_ns, stat.st_size)
  except OSError:
    return {'vendors': [], 'active': '', 'failover': True, 'source': 'env'}
  if _config_cache['stamp'] == stamp and _config_cache['value'] is not None:
    return _config_cache['value']
  try:
    raw = json.loads(PROVIDERS_CONFIG_PATH.read_text(encoding='utf-8'))
  except Exception as err:
    print(json_bytes({'event': 'provider_config', 'phase': 'load_error',
                      'error': f'{type(err).__name__}: {err}'}).decode('utf-8'), flush=True)
    return {'vendors': [], 'active': '', 'failover': True, 'source': 'env'}
  vendors = []
  for entry in raw.get('vendors') or []:
    vendor = _normalize_vendor(entry)
    if vendor:
      vendors.append(vendor)
    else:
      print(json_bytes({'event': 'provider_config', 'phase': 'vendor_skipped',
                        'vendor_id': str((entry or {}).get('vendor_id'))}).decode('utf-8'), flush=True)
  active = str(raw.get('active_vendor_id') or '').strip()
  if active not in {v['vendor_id'] for v in vendors}:
    active = vendors[0]['vendor_id'] if vendors else ''
  value = {'vendors': vendors, 'active': active,
           'failover': bool(raw.get('failover', True)), 'source': 'file'}
  _config_cache.update(stamp=stamp, value=value)
  return value


def active_vendor(config):
  for vendor in config['vendors']:
    if vendor['vendor_id'] == config['active']:
      return vendor
  return config['vendors'][0] if config['vendors'] else _legacy_vendor()


def vendor_chain(config):
  """failover 链：active 优先，其余按声明顺序；缺 key/URL 的已在 normalize 阶段剔除。"""
  vendors = config['vendors']
  if not vendors:
    legacy = _legacy_vendor()
    return [legacy] if legacy else []
  ordered = [v for v in vendors if v['vendor_id'] == config['active']]
  ordered += [v for v in vendors if v['vendor_id'] != config['active']]
  return ordered


# ============================ 上游错误分类 ============================
# 与 Garden-Design-Calculator ai_worker 同一套语义：
#   auth=凭据失效（终态，不重试不切换）；rejected=上游明确拒绝（终态）；
#   retryable=408/429/5xx、响应损坏（可重试）；unreachable=连接级失败（可重试）。
TERMINAL_CLASSES = ('auth', 'rejected')
RETRYABLE_CLASSES = ('retryable', 'unreachable')


class UpstreamError(Exception):
  def __init__(self, error_class, message, status=None, body=None, stage=None):
    super().__init__(message)
    self.error_class = error_class
    self.status = status
    self.body = body
    self.stage = stage


class ClientInputError(ValueError):
  """客户端请求本身不合法（400，与供应商无关，不重试不切换）。"""


def classify_http_error(code):
  if code in (401, 403):
    return 'auth'
  if code in (408, 429) or code >= 500:
    return 'retryable'
  return 'rejected'


def open_upstream(url, body, headers, timeout, method='POST'):
  """urllib 转发；连接级/超时/HTTP 错误统一折算为 UpstreamError。

  stage: not_sent=请求未送达（重试安全，通常不计费）；sent_no_response=已发送但未拿到
  响应（可能已计费，如实标记后仍可重试）；failed=拿到 HTTP 错误响应。
  """
  request = urllib.request.Request(url, data=body, headers=headers, method=method)
  try:
    return urllib.request.urlopen(request, timeout=timeout)
  except urllib.error.HTTPError as err:
    try:
      error_body = err.read()
    except Exception:
      error_body = b''
    raise UpstreamError(classify_http_error(int(err.code)),
                        f'upstream HTTP {err.code}: {err.reason}',
                        status=int(err.code), body=error_body, stage='failed') from err
  except urllib.error.URLError as err:
    raise UpstreamError('unreachable', f'upstream unreachable: {err}',
                        stage='not_sent') from err
  except (TimeoutError, OSError) as err:
    raise UpstreamError('unreachable', f'upstream timeout/connection: {err}',
                        stage='sent_no_response') from err


# ============================ openai_compat 适配器 ============================

def openai_base_endpoint(base_url, suffix):
  """base_url + suffix。base 无路径（纯 host）时按惯例插入 /v1；
  已带路径（/v1 或自定义前缀）时直接拼接。"""
  parsed = urllib.parse.urlsplit(base_url)
  path = parsed.path.rstrip('/')
  if not path:
    path = '/v1'
  return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path + '/' + suffix, '', ''))


def decode_data_uri(value, what='image'):
  match = re.match(r'^data:(image/[\w.+-]+);base64,(.*)$', str(value or ''), re.DOTALL)
  if not match:
    raise ClientInputError(f'{what} must be a data:image/*;base64 URI')
  try:
    data = base64.b64decode(match.group(2))
  except (ValueError, TypeError) as err:
    raise ClientInputError(f'{what} is not valid base64: {err}') from err
  if not data:
    raise ClientInputError(f'{what} is empty')
  return data, match.group(1)


def encode_data_uri(data, mime):
  return f'data:{mime or "image/png"};base64,' + base64.b64encode(data).decode('ascii')


def parse_inbound_image_request(suffix, content_type, body):
  """入站图片请求 → 统一规范形（fields + images 字节 + mask）。

  兼容三种入站形态：
  - JSON generations（纯文生图标准请求）
  - JSON edits（Intelalloc relay 形：images=[{image_url: data-uri}]）
  - multipart edits（标准 OpenAI 形：image/image[] 文件 + mask）
  """
  fields = {}
  images = []
  mask = None
  if suffix == 'images/generations':
    if not content_type.startswith('application/json'):
      raise ClientInputError('generations request body must be JSON')
    try:
      payload = json.loads(body.decode('utf-8'))
    except ValueError as err:
      raise ClientInputError(f'invalid JSON body: {err}') from err
    if not isinstance(payload, dict):
      raise ClientInputError('image request body must be a JSON object')
    fields = payload
    return {'suffix': suffix, 'fields': fields, 'images': images, 'mask': mask}
  # suffix == images/edits
  if content_type.startswith('application/json'):
    try:
      payload = json.loads(body.decode('utf-8'))
    except ValueError as err:
      raise ClientInputError(f'invalid JSON body: {err}') from err
    if not isinstance(payload, dict):
      raise ClientInputError('image request body must be a JSON object')
    if any(key in payload for key in ('image', 'mask')):
      raise ClientInputError('reference images must use multipart/form-data or relay images[]')
    raw_images = payload.get('images') or []
    if not isinstance(raw_images, list) or not raw_images:
      raise ClientInputError('edits request is missing the input image')
    for item in raw_images:
      if not isinstance(item, dict) or not isinstance(item.get('image_url'), str):
        raise ClientInputError('images must contain image data URIs')
      data, mime = decode_data_uri(item['image_url'])
      images.append((data, mime))
    raw_mask = payload.get('mask')
    if isinstance(raw_mask, dict) and isinstance(raw_mask.get('image_url'), str):
      mask = decode_data_uri(raw_mask['image_url'], 'mask')
    fields = {k: v for k, v in payload.items() if k not in ('images', 'mask')}
  elif content_type.startswith('multipart/form-data'):
    fields, files = parse_multipart({'Content-Type': content_type}, body)
    if not files.get('image') and not files.get('image[]'):
      raise ClientInputError('edits request is missing the input image')
    unknown_files = set(files) - {'image', 'image[]', 'mask'}
    if unknown_files:
      raise ClientInputError('unsupported image file field')
    for name in ('image', 'image[]'):
      for item in files.get(name) or []:
        mime = item['content_type']
        if not mime.startswith('image/') or not item['data']:
          raise ClientInputError('invalid input image')
        images.append((item['data'], mime))
    if files.get('mask'):
      if len(files['mask']) != 1:
        raise ClientInputError('only one mask is supported')
      item = files['mask'][0]
      if not item['content_type'].startswith('image/') or not item['data']:
        raise ClientInputError('invalid mask image')
      mask = (item['data'], item['content_type'])
  else:
    raise ClientInputError('unsupported image request content type')
  return {'suffix': suffix, 'fields': fields, 'images': images, 'mask': mask}


def clamp_count(value):
  try:
    count = int(value)
  except (TypeError, ValueError):
    count = 1
  return max(1, min(MAX_IMAGE_COUNT, count))


def openai_common_params(vendor, fields):
  """images JSON 请求的受管字段（模型/尺寸/流式），generations 与 edits 共用。"""
  params = {
    'model': vendor['model'],
    'n': clamp_count(fields.get('n', 1)),
    'size': vendor['size'],
    'quality': vendor['quality'],
    'output_format': vendor['output_format'],
    'background': vendor['background'],
  }
  if vendor['stream']:
    params['stream'] = True
    params['partial_images'] = vendor['partial_images']
  else:
    params['stream'] = False
  return params


def build_openai_generations(vendor, inbound):
  """文生图：标准 OpenAI images/generations JSON（与线上 10-13 版行为一致：
  移除 response_format、补默认值、按 vendor 配置决定流式）。"""
  body = {k: v for k, v in inbound['fields'].items()
          if k not in ('model', 'response_format', 'stream', 'partial_images', 'n',
                       'size', 'quality', 'output_format', 'background')}
  body.update(openai_common_params(vendor, inbound['fields']))
  return openai_base_endpoint(vendor['base_url'], 'images/generations'), json_bytes(body), 'application/json; charset=utf-8'


def build_openai_edits(vendor, inbound):
  """参考图编辑：按 vendor.edits_protocol 出站。
  - relay_json（Intelalloc 私有）：JSON {model, prompt, images:[{image_url: data-uri}], ...}
  - multipart（标准 OpenAI）：multipart/form-data，文件 image[] + mask
  """
  fields = inbound['fields']
  if vendor['edits_protocol'] == 'relay_json':
    body = {k: v for k, v in fields.items()
            if k not in ('model', 'response_format', 'stream', 'partial_images', 'n',
                         'size', 'quality', 'output_format', 'background')}
    body.update(openai_common_params(vendor, fields))
    body['images'] = [{'image_url': encode_data_uri(data, mime)}
                      for data, mime in inbound['images']]
    if inbound['mask']:
      body['mask'] = {'image_url': encode_data_uri(*inbound['mask'])}
    return openai_base_endpoint(vendor['base_url'], 'images/edits'), json_bytes(body), 'application/json; charset=utf-8'
  # 标准 multipart
  boundary = uuid.uuid4().hex
  parts = []
  form_fields = {
    'model': vendor['model'],
    'prompt': str(fields.get('prompt', '')),
    'n': str(clamp_count(fields.get('n', 1))),
    'stream': str(vendor['stream']).lower(),
  }
  for key in ('size', 'quality', 'output_format', 'background'):
    value = vendor[key]
    if value:
      form_fields[key] = value
  if vendor['stream']:
    form_fields['partial_images'] = str(vendor['partial_images'])
  for name, value in form_fields.items():
    parts.append(
      f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode('utf-8'))
  for index, (data, mime) in enumerate(inbound['images'], start=1):
    parts.append(
      (f'--{boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="image-{index}.{mime.split("/", 1)[1] if "/" in mime else "png"}"\r\n'
       f'Content-Type: {mime}\r\n\r\n').encode('utf-8') + data + b'\r\n')
  if inbound['mask']:
    data, mime = inbound['mask']
    parts.append(
      (f'--{boundary}\r\nContent-Disposition: form-data; name="mask"; filename="mask.{mime.split("/", 1)[1] if "/" in mime else "png"}"\r\n'
       f'Content-Type: {mime}\r\n\r\n').encode('utf-8') + data + b'\r\n')
  parts.append(f'--{boundary}--\r\n'.encode('utf-8'))
  body = b''.join(parts)
  content_type = f'multipart/form-data; boundary={boundary}'
  return openai_base_endpoint(vendor['base_url'], 'images/edits'), body, content_type


def build_openai_passthrough(vendor, suffix, body, content_type):
  """非图片路径（/responses、/models 等）：保持旧行为原样转发，仅补充鉴权与 UA。
  JSON 体中带 model 字段时改写为 vendor 模型（隐藏上游差异；客户端 model 由服务端托管）。"""
  if body and content_type.startswith('application/json'):
    try:
      payload = json.loads(body.decode('utf-8'))
    except ValueError:
      payload = None
    if isinstance(payload, dict) and payload.get('model'):
      payload['model'] = vendor['model']
      body = json_bytes(payload)
  url = openai_base_endpoint(vendor['base_url'], suffix)
  return url, body, content_type


# ============================ seedream（火山 ARK）适配器 ============================
# 协议对齐 Garden-Design-Calculator ai_provider_seedream.py：
# - 单端点 POST {base}/images/generations（base 兼容 ARK 根/带路径中转/完整 endpoint）
# - 请求 {model, prompt, size?, quality?, response_format, image?: [data-uri ×N]}（无流式）
# - 响应 {data:[{url}|{b64_json}]}；url 为有时效地址，经 /api/image-fetch 服务端代理下载
# - n>1 时服务端串行出图后合并 data[]（每张独立请求独立重试，失败整体报错不静默丢图）

def seedream_endpoint(base_url):
  base = str(base_url or '').strip().rstrip('/')
  if base.endswith('/images/generations'):
    return base
  return base + '/images/generations'


def build_seedream_body(vendor, inbound):
  fields = inbound['fields']
  body = {'model': vendor['model'], 'prompt': str(fields.get('prompt', ''))}
  if vendor['size'] and vendor['size'].lower() != 'auto':
    body['size'] = vendor['size']
  if vendor['quality'] and vendor['quality'].lower() != 'auto':
    body['quality'] = vendor['quality']
  if vendor['response_format'] in ('url', 'b64_json'):
    body['response_format'] = vendor['response_format']
  if inbound['images']:
    body['image'] = [encode_data_uri(data, mime) for data, mime in inbound['images']]
  return body


def seedream_headers(vendor, request_id):
  return {
    'Authorization': 'Bearer ' + vendor['api_key'],
    'Content-Type': 'application/json; charset=utf-8',
    'Accept': 'application/json',
    'Accept-Encoding': 'identity',
    'X-Request-ID': request_id,
    'User-Agent': vendor['user_agent'] or SEEDREAM_USER_AGENT,
  }


def post_seedream_once(vendor, body, timeout, request_id):
  """单次 ARK 请求 → (payload, items)；items 仅保留含 url/b64_json 的成品（fail-closed）。"""
  with open_upstream(seedream_endpoint(vendor['base_url']), body,
                     seedream_headers(vendor, request_id), timeout) as response:
    status = response.status
    try:
      raw = response.read()
    except (TimeoutError, OSError, http.client.HTTPException) as err:
      raise UpstreamError('unreachable', f'upstream read failed: {err}',
                          stage='sent_no_response') from err
  if status != 200:
    detail = raw.decode('utf-8', 'replace')[:300]
    raise UpstreamError(classify_http_error(status), f'upstream HTTP {status}: {detail}',
                        status=status, body=raw, stage='failed')
  try:
    payload = json.loads(raw.decode('utf-8'))
  except ValueError as err:
    raise UpstreamError('retryable', f'upstream response is not valid JSON: {err}',
                        stage='sent_no_response') from err
  if isinstance(payload, dict) and payload.get('error'):
    raise UpstreamError('rejected', f'upstream error: {json_bytes(payload["error"])[:300]}',
                        status=status, body=raw, stage='failed')
  data = payload.get('data') if isinstance(payload, dict) else None
  items = [item for item in (data or []) if isinstance(item, dict)
           and (item.get('url') or item.get('b64_json'))]
  if not items:
    raise UpstreamError('retryable', 'seedream response has no final image',
                        stage='sent_no_response')
  return payload, items


def call_seedream(vendor, inbound, request_id, trace):
  """n>1 串行出图合并；返回 {data:[...], ...} 规范形 JSON 可直接下发。"""
  if inbound['mask']:
    raise ClientInputError('当前生图供应商（Seedream）不支持 mask 局部重绘')
  count = clamp_count(inbound['fields'].get('n', 1))
  body = json.dumps(build_seedream_body(vendor, inbound), ensure_ascii=False).encode('utf-8')
  merged = []
  last_payload = None
  for index in range(count):
    trace('seedream_image_start', image_index=index + 1, total=count)
    payload, items = post_seedream_once(vendor, body, vendor['timeout_seconds'], request_id)
    merged.extend(items)
    last_payload = payload
  result = {'data': merged}
  if isinstance(last_payload, dict):
    for key in ('created', 'id', 'usage'):
      if key in last_payload:
        result[key] = last_payload[key]
  return result


# ============================ 出站请求头 ============================

def outbound_headers(vendor, inbound_content_type, is_image, request_id):
  headers = {
    'Authorization': 'Bearer ' + vendor['api_key'],
    'Accept': 'text/event-stream, application/json' if (is_image and vendor['stream']) else 'application/json',
    'Accept-Encoding': 'identity',
    'X-Request-ID': request_id,
    'User-Agent': vendor['user_agent'] or UPSTREAM_USER_AGENT,
  }
  if inbound_content_type:
    headers['Content-Type'] = inbound_content_type
  return headers


# ============================ 响应归一化 ============================

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


def image_result(value):
  """Convert a Responses image result to the existing Images client contract."""
  if isinstance(value, str) and value.strip():
    return {'url': value} if value.startswith('https://') else {'b64_json': value}
  if isinstance(value, dict):
    for key in ('url', 'b64_json', 'base64', 'image', 'image_b64', 'image_base64', 'data'):
      if isinstance(value.get(key), str) and value[key].strip():
        return image_result(value[key]) if key != 'url' else {'url': value[key]}
  return None


def complete_image_results(node):
  """Vendor completion events may nest image values below response/output/result."""
  results = []
  if isinstance(node, dict):
    for key in ('b64_json', 'image', 'image_b64', 'image_base64', 'result'):
      value = node.get(key)
      if isinstance(value, str) and value.strip():
        results.append(image_result(value))
    for value in node.values():
      if isinstance(value, (dict, list)):
        results.extend(complete_image_results(value))
  elif isinstance(node, list):
    for value in node:
      results.extend(complete_image_results(value))
  return results


def normalize_image_response(payload):
  if not isinstance(payload, dict):
    raise ValueError('invalid image response')
  if payload.get('error'):
    return payload
  if isinstance(payload.get('data'), list) and any(
      isinstance(item, dict) and (item.get('url') or item.get('b64_json'))
      for item in payload['data']):
    return payload
  response = payload.get('response', payload)
  if not isinstance(response, dict):
    raise ValueError('invalid response envelope')
  if response.get('error'):
    return {'error': response['error']}
  results = []
  for item in response.get('output', []):
    if not isinstance(item, dict) or item.get('type') != 'image_generation_call':
      continue
    result = image_result(item.get('result'))
    if result:
      if item.get('revised_prompt'):
        result['revised_prompt'] = item['revised_prompt']
      results.append(result)
  if not results:
    raise ValueError('image response has no final image')
  return {**response, 'data': results}


class ImageStreamState:
  def __init__(self):
    self.seen = []
    self.final = False
    self.failed = False

  def normalize(self, payload, event_type=''):
    kind = payload.get('type') or event_type
    if kind and kind not in self.seen:
      self.seen.append(kind)
    if payload.get('error') or kind in ('error', 'response.failed', 'response.incomplete'):
      self.failed = True
      detail = payload.get('error') or payload.get('response', {}).get('error')
      return {'type': 'error', 'error': detail or {'message': 'upstream image response failed'}}
    if kind == 'response.image_generation_call.partial_image':
      return {**payload, 'type': 'image_generation.partial_image',
              'b64_json': payload.get('partial_image_b64', '')}
    if kind == 'response.completed':
      try:
        payload = normalize_image_response(payload)
      except ValueError:
        results = complete_image_results(payload)
        if results:
          payload = {**payload, 'data': results}
        # Otherwise EOF diagnostic includes all observed event types.
    elif not kind or ('complete' in kind.lower() and 'partial' not in kind.lower()):
      if not isinstance(payload.get('data'), list) and not payload.get('b64_json') and not payload.get('url'):
        results = complete_image_results(payload)
        if results:
          payload = {**payload, 'data': results}
    if kind == 'response.output_item.done':
      item = payload.get('item', {})
      if isinstance(item, dict) and item.get('type') == 'image_generation_call':
        result = image_result(item.get('result'))
        if result:
          # Wait for response.completed so the same image is not emitted twice.
          return payload
    if isinstance(payload.get('data'), list) and any(
        isinstance(item, dict) and (item.get('url') or item.get('b64_json'))
        for item in payload['data']):
      self.final = True
    if kind in ('image_generation.completed', 'image_edit.completed') and (
        payload.get('url') or payload.get('b64_json')):
      self.final = True
    return payload


def rewrite_sse_event(block, origin, state=None):
  lines = block.decode('utf-8').splitlines()
  data = '\n'.join(line[5:].lstrip(' ') for line in lines if line.startswith('data:'))
  if not data or data.strip() == '[DONE]':
    return block + b'\n\n'
  payload = json.loads(data)
  if state is not None:
    kind = next((line[6:].strip() for line in lines if line.startswith('event:')), '')
    payload = state.normalize(payload, kind)
  proxy_image_urls(payload, origin)
  # 保留 event/id/retry/注释；仅合并单个完整事件的 data 行。
  metadata = [line for line in lines if not line.startswith('data:')]
  return ('\n'.join(metadata + ['data: ' + json_bytes(payload).decode('utf-8')]) + '\n\n').encode('utf-8')


# ============================ 供应商尝试循环 ============================

def build_openai_outbound(vendor, suffix, inbound, raw_body, raw_content_type):
  """openai_compat 出站构造。图片请求用已解析的规范形 inbound；其余路径原样透传。"""
  if suffix == 'images/generations':
    return build_openai_generations(vendor, inbound)
  if suffix == 'images/edits':
    return build_openai_edits(vendor, inbound)
  return build_openai_passthrough(vendor, suffix, raw_body, raw_content_type)


def sleep_backoff(attempt_no):
  if attempt_no > 0:
    time.sleep(RETRY_BACKOFF_SECONDS[min(attempt_no - 1, len(RETRY_BACKOFF_SECONDS) - 1)])


class Handler(SimpleHTTPRequestHandler):
  server_version = 'AICompanyGallery/1.1'

  def __init__(self, *args, **kwargs):
    super().__init__(*args, directory=str(APP_DIR), **kwargs)

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
      if parsed.path == '/api/health':
        return self.send_json(200, {'ok': True, 'service': 'ai-gallery'})
      if parsed.path == '/api/runtime-config':
        return self.handle_runtime_config()
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
    except ClientInputError as err:
      return self.send_json(400, {'error': str(err)})

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
    except ClientInputError as err:
      return self.send_json(400, {'error': str(err)})
    except ValueError as err:
      return self.send_json(400, {'error': str(err)})
    except Exception as err:
      self.log_error('request failed: %s', err)
      return self.send_json(500, {'error': 'server error'})

  def handle_runtime_config(self):
    vendor = active_vendor(load_provider_config())
    if vendor:
      return self.send_json(200, {
        'model': vendor['model'],
        'streamImages': bool(vendor['stream'] and vendor['adapter'] == 'openai_compat'),
        'streamPartialImages': vendor['partial_images'],
      })
    return self.send_json(200, {'model': UPSTREAM_MODEL, 'streamImages': STREAM_IMAGES,
                                'streamPartialImages': PARTIAL_IMAGES})

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
      request = urllib.request.Request(url, headers={'User-Agent': UPSTREAM_USER_AGENT})
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

  # ---------------------------- 代理与可靠性主流程 ----------------------------

  def handle_proxy(self):
    config = load_provider_config()
    chain = vendor_chain(config)
    if not chain:
      return self.send_json(503, {'error': 'upstream API is not configured'})

    started = time.monotonic()
    request_id = uuid.uuid4().hex
    state = {'vendor': None, 'attempt': None, 'failovers': 0}
    self._last_status = None

    def trace(phase, **fields):
      print(json_bytes({'event': 'api_proxy', 'request_id': request_id,
                        'phase': phase, 'elapsed_ms': round((time.monotonic() - started) * 1000),
                        'vendor': state['vendor'], 'attempt': state['attempt'], **fields}).decode('utf-8'),
            flush=True)

    parsed = urllib.parse.urlsplit(self.path)
    suffix = parsed.path[len('/api-proxy/'):].lstrip('/')
    is_image = suffix in IMAGE_SUFFIXES
    query = ('?' + parsed.query) if parsed.query else ''
    body = self.read_body() if self.command in ('POST', 'PUT', 'PATCH') else None
    content_type = self.headers.get('Content-Type', '')
    trace('start', endpoint=suffix, request_bytes=len(body) if body else 0,
          chain=[v['vendor_id'] for v in chain], failover_enabled=config['failover'])

    # 入站解析一次（与供应商无关）：非法请求直接 400，不进入重试/切换。
    inbound = None
    if is_image and body:
      try:
        inbound = parse_inbound_image_request(suffix, content_type, body)
      except ClientInputError as err:
        trace('client_input_error', error=str(err))
        raise
      except ValueError as err:
        trace('client_input_error', error=str(err))
        raise ClientInputError(str(err))
    trace('request_parsed', images=len(inbound['images']) if inbound else None)

    terminal = None  # (status, body, content_type, vendor) 终态错误透传
    for position, vendor in enumerate(chain):
      if position > 0:
        if not config['failover']:
          break
        state['failovers'] = position
      state['vendor'] = vendor['vendor_id']
      state['attempt'] = None
      trace('vendor_selected', adapter=vendor['adapter'], position=position)
      max_retries = max(0, vendor['max_retries'])
      for attempt_no in range(max_retries + 1):
        state['attempt'] = attempt_no
        sleep_backoff(attempt_no)
        try:
          if vendor['adapter'] == 'seedream':
            if not is_image or inbound is None:
              raise ClientInputError('当前生图供应商（Seedream）不支持该接口，仅支持图片生成/编辑')
            payload = call_seedream(vendor, inbound, request_id, trace)
            origin = 'http://' + self.headers.get('Host', f'127.0.0.1:{PORT}')
            proxy_image_urls(payload, origin)
            self._last_status = 200
            self.deliver_json(payload, vendor, request_id)
            trace('end', status=200)
            return
          url, out_body, out_content_type = build_openai_outbound(
            vendor, suffix, inbound, body, content_type)
          trace('upstream_open_start', endpoint=urllib.parse.urlsplit(url).path,
                forwarded_bytes=len(out_body) if out_body else 0,
                content_type=out_content_type.split(';')[0])
          headers = outbound_headers(vendor, out_content_type, is_image and vendor['stream'], request_id)
          with open_upstream(url + query, out_body, headers, vendor['timeout_seconds'],
                             method=self.command) as response:
            outcome = self.forward_upstream_response(
              response, vendor, is_image, request_id, trace)
            if outcome == 'done':
              trace('end', status=self._last_status)
              return
            if outcome == 'stream_started_unrecoverable':
              # 流式已向客户端转发内容：无法重试，错误事件已下发，维持连接结束。
              trace('end', status='stream_error_after_forward')
              return
            # outcome == 'retry'（尚未向客户端发送任何字节，可整体重试）
            trace('attempt_retryable', reason='response_unusable_pre_forward')
            continue
        except ClientInputError as err:
          trace('client_input_error', error=str(err))
          raise
        except UpstreamError as err:
          trace('attempt_failed', error_class=err.error_class, http_status=err.status,
                stage=err.stage, error=str(err)[:200])
          if err.error_class in TERMINAL_CLASSES:
            terminal = (err.status or 502, err.body or json_bytes({'error': {'message': str(err)}}),
                        'application/json; charset=utf-8', vendor)
            break  # 终态：不重试不切换（退出 attempt 循环；下方同步退出 vendor 循环）
          if attempt_no < max_retries:
            continue
          trace('vendor_exhausted', vendor=vendor['vendor_id'])
          if position + 1 < len(chain):
            break  # 跳出 attempt 循环，进入下一 vendor（failover）
          terminal = (err.status or 502,
                      json_bytes({'error': {'message': f'所有生图供应商均不可用（已尝试 {position + 1} 家）；请稍后重试，请勿连续重复提交以免重复计费。',
                                            'request_id': request_id}}),
                      'application/json; charset=utf-8', vendor)
        except Exception as err:  # 未知异常按可重试处理（与 GDC ai_worker 同一口径），绝不让请求 500 中断
          trace('attempt_failed', error_class='unexpected', error_type=type(err).__name__,
                error=str(err)[:200])
          if attempt_no < max_retries:
            continue
          if position + 1 < len(chain):
            break
          terminal = (502, json_bytes({'error': {'message': '生图供应商调用异常，已重试仍失败；请凭请求编号排查。',
                                                 'request_id': request_id}}),
                      'application/json; charset=utf-8', vendor)
      if terminal is not None:
        break  # auth/rejected 终态：停止 failover
    if terminal:
      status, error_body, error_type, vendor = terminal
      trace('terminal_error', status=status, vendor=vendor['vendor_id'])
      try:
        self.send_response(status)
        self.send_header('Content-Type', error_type)
        self.send_header('Content-Length', str(len(error_body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Request-ID', request_id)
        self.send_header('X-AI-Vendor', vendor['vendor_id'])
        self.end_headers()
        self.wfile.write(error_body)
      except (BrokenPipeError, ConnectionResetError):
        pass
      return
    # chain 遍历完但没有任何 terminal/成功（例如 failover 关闭且第一家重试耗尽）
    trace('end', status='no_vendor_succeeded')
    try:
      self.send_json(502, {'error': '所有生图供应商均不可用；请稍后重试。', 'request_id': request_id},
                     {'X-Request-ID': request_id})
    except (BrokenPipeError, ConnectionResetError):
      pass

  def deliver_json(self, payload, vendor, request_id):
    body = json_bytes(payload)
    self.send_response(200)
    self.send_header('Content-Type', 'application/json; charset=utf-8')
    self.send_header('Content-Length', str(len(body)))
    self.send_header('Cache-Control', 'no-store')
    self.send_header('X-Request-ID', request_id)
    self.send_header('X-AI-Vendor', vendor['vendor_id'])
    self.end_headers()
    try:
      self.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
      pass

  def forward_upstream_response(self, response, vendor, suffix_is_image,
                                request_id, trace):
    """转发上游响应。返回 'done'（已完成）| 'retry'（可整体重试）|
    'stream_started_unrecoverable'（流式已转发后失败，错误事件已下发）。"""
    status = response.status
    self._last_status = status
    response_type = response.headers.get('Content-Type', 'application/octet-stream')
    trace('upstream_headers', status=status, content_type=response_type,
          cf_ray=response.headers.get('CF-Ray'),
          upstream_request_id=response.headers.get('X-Request-ID'))
    origin = 'http://' + self.headers.get('Host', f'127.0.0.1:{PORT}')
    forwarded = False

    if 'text/event-stream' in response_type.lower():
      self.send_response(status)
      self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
      self.send_header('Cache-Control', 'no-store, no-transform')
      self.send_header('X-Accel-Buffering', 'no')
      self.send_header('X-Request-ID', request_id)
      self.send_header('X-AI-Vendor', vendor['vendor_id'])
      self.send_header('Connection', 'close')
      self.end_headers()
      self.wfile.flush()
      self.close_connection = True
      image_state = ImageStreamState() if suffix_is_image else None
      buffer = b''
      chunks = 0
      events = 0
      last_chunk = time.monotonic()
      max_gap = 0
      try:
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
            try:
              rewritten = rewrite_sse_event(event, origin, image_state)
            except Exception as err:
              # 单事件损坏：通知客户端并终止（此时多半已有事件转发，无法重试）
              trace('stream_event_error', error=str(err)[:200])
              if not forwarded:
                return 'retry'
              self.wfile.write(b'data: ' + json_bytes(
                {'type': 'error', 'error': {'message': '流式事件解析失败；请求编号：' + request_id}}) + b'\n\n')
              self.wfile.flush()
              return 'stream_started_unrecoverable'
            forwarded = True
            self.wfile.write(rewritten)
            self.wfile.flush()
            events += 1
            if events == 1:
              trace('downstream_first_event')
            separator = re.search(rb'\r?\n\r?\n', buffer)
          if len(buffer) > MAX_BODY:
            raise ValueError('SSE event too large')
        if buffer.strip():
          try:
            rewritten = rewrite_sse_event(buffer, origin, image_state)
          except Exception as err:
            trace('stream_event_error', error=str(err)[:200])
            if not forwarded:
              return 'retry'
          else:
            forwarded = True
            self.wfile.write(rewritten)
            self.wfile.flush()
        if image_state and not image_state.final and not image_state.failed:
          detail = '流式响应缺少最终图片；已见事件：' + ', '.join(image_state.seen or ['(none)'])
          self.wfile.write(b'data: ' + json_bytes(
            {'type': 'error', 'error': {'message': detail + '；请求编号：' + request_id}}) + b'\n\n')
          self.wfile.flush()
        trace('image_stream_result', final_image=image_state.final if image_state else None,
              event_types=image_state.seen if image_state else [])
        trace('stream_complete', chunks=chunks, events=events, max_chunk_gap_ms=round(max_gap * 1000))
        return 'done'
      except (BrokenPipeError, ConnectionResetError):
        trace('client_disconnected')
        return 'done'
      except (urllib.error.URLError, TimeoutError, OSError) as err:
        trace('transport_error', error_type=type(err).__name__, forwarded_any=forwarded)
        if not forwarded:
          return 'retry'
        try:
          self.wfile.write(b'data: ' + json_bytes(
            {'type': 'error',
             'error': {'message': '上游连接或流式响应异常，请凭请求编号排查；请勿直接重复提交，以免重复计费。 ' + request_id}}) + b'\n\n')
          self.wfile.flush()
        except OSError:
          pass
        return 'stream_started_unrecoverable'

    response_body = response.read()
    trace('upstream_body_complete', response_bytes=len(response_body))
    if response_type.startswith('application/json'):
      try:
        payload = json.loads(response_body.decode('utf-8'))
      except ValueError:
        # 上游声称 JSON 但解析失败 → 可整体重试（尚未向客户端发送任何字节）
        trace('response_parse_error')
        return 'retry'
      if suffix_is_image and vendor['adapter'] == 'seedream':
        # seedream 非流式响应：data[] 已在适配器校验；url 走 /api/image-fetch 代理
        proxy_image_urls(payload, origin)
      elif suffix_is_image:
        try:
          payload = normalize_image_response(payload)
        except ValueError:
          trace('response_normalize_error')
          return 'retry'
        proxy_image_urls(payload, origin)
      response_body = json_bytes(payload)
      response_type = 'application/json; charset=utf-8'
    self.send_response(status)
    self.send_header('Content-Type', response_type)
    self.send_header('Content-Length', str(len(response_body)))
    self.send_header('Cache-Control', 'no-store')
    self.send_header('X-Request-ID', request_id)
    self.send_header('X-AI-Vendor', vendor['vendor_id'])
    self.end_headers()
    try:
      self.wfile.write(response_body)
    except (BrokenPipeError, ConnectionResetError):
      trace('client_disconnected')
    return 'done'


if __name__ == '__main__':
  init_storage()
  config = load_provider_config()
  chain = vendor_chain(config)
  print(f'AI Gallery listening on {HOST}:{PORT}', flush=True)
  print(json_bytes({'event': 'provider_config', 'phase': 'boot', 'source': config['source'],
                    'active': config['active'],
                    'chain': [v['vendor_id'] + ':' + v['adapter'] for v in chain]}).decode('utf-8'),
        flush=True)
  ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
