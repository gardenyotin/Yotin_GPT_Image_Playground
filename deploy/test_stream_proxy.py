"""1.1 部署基线的本机协议 smoke；临时数据、loopback 假上游、禁止真实出站。"""
import base64
import http.client
import http.server
import ipaddress
import json
import os
from pathlib import Path
import socket
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch


# 配置在 import 时读取；不能继承真实供应商配置或 /opt 数据路径。
with tempfile.TemporaryDirectory(prefix='gallery-import-') as import_dir:
  with patch.dict(os.environ, {**{
      key: value for key, value in os.environ.items() if not key.startswith('AI_GALLERY_')
    }, 'AI_GALLERY_APP_DIR': import_dir + '/app',
    'AI_GALLERY_DATA_DIR': import_dir + '/data',
    'AI_GALLERY_PROVIDERS_CONFIG': import_dir + '/missing.json'}, clear=True):
    import ai_gallery_server as gallery


def multipart(images, prompt='原样提示词'):
  boundary = 'local-smoke-boundary'
  parts = []
  for name, value in {'prompt': prompt, 'model': 'ignored-client-model'}.items():
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
  for index, image in enumerate(images):
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="{index}.png"\r\n'
                  'Content-Type: image/png\r\n\r\n').encode() + image + b'\r\n')
  parts.append(f'--{boundary}--\r\n'.encode())
  return b''.join(parts), f'multipart/form-data; boundary={boundary}'


class StreamProxyTests(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory(prefix='gallery-baseline-')
    self.addCleanup(self.temp.cleanup)
    root = Path(self.temp.name)
    self.captured = []
    self.release = threading.Event()
    captured, release = self.captured, self.release

    class Upstream(http.server.BaseHTTPRequestHandler):
      def log_message(self, *args):
        pass

      def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        if self.headers['Content-Type'].startswith('multipart/'):
          fields, files = gallery.parse_multipart(self.headers, body)
        else:
          fields, files = json.loads(body), {}
        captured.append({'path': self.path, 'fields': fields, 'files': files,
                         'authorization': self.headers.get('Authorization')})
        if fields.get('prompt') == 'reject':
          self.send_response(401)
          self.send_header('Content-Type', 'application/json')
          self.end_headers()
          self.wfile.write(b'{"error":{"message":"fake rejection"}}')
          return
        self.send_response(200)
        if fields.get('prompt') == 'stream':
          self.send_header('Content-Type', 'text/event-stream')
          self.end_headers()
          self.wfile.write(b': heartbeat\r\n\r\n')
          self.wfile.flush()
          release.wait(4)
          # 网络块刻意切在 JSON 内部，验证事件组装与最终结果识别。
          self.wfile.write(b'data: {"type":"image_edit.completed",')
          self.wfile.flush()
          self.wfile.write(b'"url":"https://image.invalid/final.png"}\r\n\r\ndata: [DONE]\n\n')
        else:
          self.send_header('Content-Type', 'application/json')
          self.end_headers()
          self.wfile.write(b'{"data":[{"url":"https://image.invalid/final.png"}]}')

    self.upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    self.proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 0), gallery.Handler)
    self.vendor = {
      'vendor_id': 'local-fake', 'adapter': 'openai_compat',
      'base_url': f'http://127.0.0.1:{self.upstream.server_port}',
      'api_key': 'fake-local-only', 'model': 'fake-server-model',
      'edits_protocol': 'relay_json', 'stream': True, 'partial_images': 3,
      'max_retries': 0, 'timeout_seconds': 30,
    }
    self.config_path = root / 'ai-providers.json'
    self.write_config()
    self.enterContext(patch.multiple(gallery, APP_DIR=root / 'app', DATA_DIR=root / 'data',
                                    DB_PATH=root / 'data' / 'gallery.db',
                                    PROVIDERS_CONFIG_PATH=self.config_path,
                                    UPSTREAM_URL='', UPSTREAM_KEY='',
                                    _config_cache={'stamp': None, 'value': None}))
    gallery.init_storage()
    # URL 和 socket 两道限制覆盖 urllib、重定向、直接 http.client；禁用环境代理。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_getaddrinfo = socket.getaddrinfo

    def guard(address):
      try:
        allowed = isinstance(address, tuple) and ipaddress.ip_address(address[0]).is_loopback
      except ValueError:
        allowed = False
      if not allowed:
        raise AssertionError('smoke forbids non-loopback socket connections')

    def local_connect(sock, address):
      guard(address)
      return original_connect(sock, address)

    def local_connect_ex(sock, address):
      guard(address)
      return original_connect_ex(sock, address)

    def local_getaddrinfo(host, port, *args, **kwargs):
      guard((host, port))
      return original_getaddrinfo(host, port, *args, **kwargs)

    def local_urlopen(request, *args, **kwargs):
      url = request.full_url if isinstance(request, urllib.request.Request) else request
      parsed = urllib.parse.urlsplit(url)
      if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.port != self.upstream.server_port:
        raise AssertionError('smoke forbids unregistered upstream URLs')
      return opener.open(request, *args, **kwargs)

    self.enterContext(patch.object(socket.socket, 'connect', local_connect))
    self.enterContext(patch.object(socket.socket, 'connect_ex', local_connect_ex))
    self.enterContext(patch.object(socket, 'getaddrinfo', local_getaddrinfo))
    self.enterContext(patch.object(gallery.urllib.request, 'urlopen', local_urlopen))
    for server in (self.upstream, self.proxy):
      threading.Thread(target=server.serve_forever, daemon=True).start()
    self.addCleanup(self.close_servers)

  def close_servers(self):
    self.release.set()
    for server in (self.proxy, self.upstream):
      server.shutdown()
      server.server_close()

  def write_config(self):
    self.config_path.write_text(json.dumps({'schema': 1, 'active_vendor_id': 'local-fake',
                                           'failover': False, 'vendors': [self.vendor]}))

  def request(self, path, body=None, content_type='application/json'):
    conn = http.client.HTTPConnection('127.0.0.1', self.proxy.server_port, timeout=2)
    self.addCleanup(conn.close)
    conn.request('GET' if body is None else 'POST', path, body, {'Content-Type': content_type})
    response = conn.getresponse()
    return response, response.read()

  def test_health_and_runtime_use_isolated_configuration(self):
    response, body = self.request('/api/health')
    self.assertEqual(response.status, 200)
    self.assertIn('AICompanyGallery/1.1', response.getheader('Server'))
    self.assertEqual(json.loads(body), {'ok': True, 'service': 'ai-gallery'})
    response, body = self.request('/api/runtime-config')
    self.assertEqual(response.status, 200)
    self.assertEqual(json.loads(body), {'model': 'fake-server-model', 'streamImages': True,
                                       'streamPartialImages': 3})
    self.assertEqual(self.captured, [])

  def test_single_and_double_images_preserve_order_in_both_protocols(self):
    for protocol in ('relay_json', 'multipart'):
      self.vendor['edits_protocol'] = protocol
      self.write_config()
      for images in ([b'first-image'], [b'first-image', b'second-image']):
        with self.subTest(protocol=protocol, count=len(images)):
          body, content_type = multipart(images)
          response, result = self.request('/api-proxy/images/edits', body, content_type)
          self.assertEqual(response.status, 200)
          self.assertEqual(response.getheader('X-AI-Vendor'), 'local-fake')
          sent = self.captured[-1]
          self.assertEqual(sent['path'], '/v1/images/edits')
          self.assertEqual(sent['authorization'], 'Bearer fake-local-only')
          self.assertEqual(sent['fields']['model'], 'fake-server-model')
          self.assertEqual(sent['fields']['prompt'], '原样提示词')
          if protocol == 'relay_json':
            actual = [base64.b64decode(image['image_url'].split(',', 1)[1])
                      for image in sent['fields']['images']]
          else:
            actual = [image['data'] for image in sent['files']['image[]']]
          self.assertEqual(actual, images)
          self.assertIn('/api/image-fetch?', json.loads(result)['data'][0]['url'])
    self.assertEqual(len(self.captured), 4)

  def test_json_generation_managed_parameters_and_result(self):
    response, result = self.request('/api-proxy/images/generations',
                                     json.dumps({'prompt': 'json', 'model': 'ignored', 'stream': False}))
    self.assertEqual(response.status, 200)
    sent = self.captured[0]
    self.assertEqual(sent['path'], '/v1/images/generations')
    self.assertEqual(sent['fields']['model'], 'fake-server-model')
    self.assertIs(sent['fields']['stream'], True)
    self.assertEqual(sent['fields']['partial_images'], 3)
    self.assertIn('/api/image-fetch?', json.loads(result)['data'][0]['url'])
    self.assertEqual(len(self.captured), 1)

  def test_real_http_stream_heartbeat_before_completion(self):
    conn = http.client.HTTPConnection('127.0.0.1', self.proxy.server_port, timeout=2)
    self.addCleanup(conn.close)
    conn.request('POST', '/api-proxy/images/generations', json.dumps({'prompt': 'stream'}),
                 {'Content-Type': 'application/json'})
    response = conn.getresponse()
    self.assertEqual(response.status, 200)
    self.assertIsNone(response.getheader('Content-Length'))
    self.assertTrue(response.getheader('X-Request-ID'))
    self.assertEqual(response.readline(), b': heartbeat\n')
    self.assertEqual(response.readline(), b'\n')
    self.assertFalse(self.release.is_set())
    self.release.set()
    result = response.read()
    self.assertIn(b'/api/image-fetch?', result)
    self.assertIn(b'data: [DONE]', result)
    self.assertNotIn(b'"type":"error"', result)
    self.assertEqual(len(self.captured), 1)

  def test_event_metadata_and_responses_final_image(self):
    event = b'event: image_edit.completed\r\nid: 1\r\ndata: {"type":"image_edit.completed","url":"https://image.invalid/final.png"}'
    result = gallery.rewrite_sse_event(event, 'http://local', gallery.ImageStreamState())
    self.assertIn(b'event: image_edit.completed', result)
    self.assertIn(b'id: 1', result)
    self.assertIn(b'http://local/api/image-fetch?', result)
    state = gallery.ImageStreamState()
    result = state.normalize({'type': 'response.completed', 'response': {
      'output': [{'type': 'image_generation_call', 'result': 'aW1hZ2U='}]}})
    self.assertTrue(state.final)
    self.assertEqual(result['data'][0]['b64_json'], 'aW1hZ2U=')
    self.assertEqual(gallery.rewrite_sse_event(b': heartbeat', 'http://local'), b': heartbeat\n\n')

  def test_rejection_and_invalid_input_do_not_reach_another_attempt(self):
    response, _ = self.request('/api-proxy/images/generations', json.dumps({'prompt': 'reject'}))
    self.assertEqual(response.status, 401)
    self.assertEqual(len(self.captured), 1)
    response, _ = self.request('/api-proxy/images/edits', json.dumps({'prompt': 'missing image'}))
    self.assertEqual(response.status, 400)
    self.assertEqual(len(self.captured), 1)

  def test_external_network_guard_fails_closed(self):
    with self.assertRaisesRegex(AssertionError, 'unregistered upstream'):
      gallery.urllib.request.urlopen('https://provider.invalid/v1/images/generations')
    with socket.socket() as sock:
      for connect in (sock.connect, sock.connect_ex):
        with self.assertRaisesRegex(AssertionError, 'non-loopback'):
          connect(('192.0.2.1', 443))
    with self.assertRaisesRegex(AssertionError, 'non-loopback'):
      socket.create_connection(('provider.invalid', 443))
    self.assertEqual(self.captured, [])

  def test_storage_initialization_preserves_existing_rows_and_media(self):
    # 在临时库造旧数据再执行幂等初始化；不接触线上数据库和媒体。
    with sqlite3.connect(gallery.DB_PATH) as db:
      db.execute('INSERT INTO users VALUES (?,?,?,?,?)', ('old-user', '旧同事', '🌱', 'old', 'old'))
      db.execute('INSERT INTO generations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                 ('old-image', 'old-user', '旧同事', '🌱', '旧提示词', '旧提示词',
                  'images/old.webp', 'thumbnails/old.webp', '["references/old.webp"]',
                  'old-sha256', 'old', 1))
      before = {table: db.execute(f'SELECT * FROM {table}').fetchall()
                for table in ('users', 'generations')}
    media = [gallery.DATA_DIR / folder / 'old.webp' for folder in ('images', 'thumbnails', 'references')]
    for path in media:
      path.write_bytes(b'old-media-unchanged')
    gallery.init_storage()
    with sqlite3.connect(gallery.DB_PATH) as db:
      after = {table: db.execute(f'SELECT * FROM {table}').fetchall()
               for table in ('users', 'generations')}
    self.assertEqual(after, before)
    self.assertTrue(all(path.read_bytes() == b'old-media-unchanged' for path in media))


if __name__ == '__main__':
  unittest.main()
