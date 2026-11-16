"""真实 HTTP 网关合同：只调用本机假身份与假生图服务，不调用供应商。"""
from contextlib import closing
import http.client
import http.server
import json
import threading
import tempfile
import urllib.parse
import unittest
from unittest.mock import patch

import ai_gallery_server as gallery


class ImageServiceGatewayTests(unittest.TestCase):
  def setUp(self):
    self.calls = []
    self.mode = 'ok'
    case = self

    class Upstream(http.server.BaseHTTPRequestHandler):
      def do_GET(self):
        self.handle_request()

      def do_POST(self):
        self.handle_request()

      def handle_request(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        case.calls.append((self.command, self.path, dict(self.headers), body))
        if self.path.startswith('/v1/images/') and case.mode == 'plain_error':
          self.send_response(500)
          self.send_header('Content-Type', 'text/plain')
          self.end_headers()
          self.wfile.write(b'Internal Server Error')
          return
        status = 200
        data = {'job_id': 'job-1', 'requested_by': 'company:alice', 'status': 'succeeded',
                'params_json': {'n': 1}, 'result_assets_json': [{'index': 0, 'storage_key': 'private/key'}]}
        if self.path == '/api/identity':
          status = 401 if self.headers.get('Cookie') == 'anonymous' else 200
          data = {'user_id': 'bob' if self.headers.get('Cookie') == 'bob' else 'alice'}
        elif self.path == '/v1/models':
          data = {'provider': 'openai_compat', 'data': [{'supports_image_input': True, 'max_input_images_per_job': 1}]}
        elif self.path.startswith('/v1/images/'):
          status = 503 if case.mode == 'reject' else 202
          data = {'error': {'code': 'internal_error', 'message': 'service unavailable'}} if status == 503 else data
        elif self.path.endswith('/cancel'):
          data = {'job_id': 'job-1', 'cancelled': True}
        elif '/result?' in self.path:
          self.send_response(200)
          self.send_header('Content-Type', 'image/png')
          self.end_headers()
          self.wfile.write(b'PNG-output')
          return
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

      def log_message(self, *_args):
        pass

    self.upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    self.gateway = http.server.ThreadingHTTPServer(('127.0.0.1', 0), gallery.Handler)
    url = f'http://127.0.0.1:{self.upstream.server_port}'
    self.config = patch.multiple(gallery, GARDEN_API_URL=url,
                                 AI_IMAGE_SERVICE_URL=url, AI_IMAGE_SERVICE_API_KEY='server-only-key')
    self.config.start()
    self.data = tempfile.TemporaryDirectory()
    self.db_config = patch.object(gallery, 'DB_PATH', self.data.name + '/gallery.db')
    self.db_config.start()
    with gallery.connect() as db:
      db.execute('CREATE TABLE users (id TEXT, nickname TEXT, avatar TEXT)')
      db.executemany('INSERT INTO users VALUES (?,?,?)', [('alice', 'alice', '🌷'), ('bob', 'bob', '🌷')])
    self.threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (self.upstream, self.gateway)]
    for t in self.threads:
      t.start()

  def tearDown(self):
    for s in (self.gateway, self.upstream):
      s.shutdown()
      s.server_close()
    self.config.stop()
    self.db_config.stop()
    self.data.cleanup()

  def request(self, path, body=None, cookie='alice', content_type='application/json'):
    with closing(http.client.HTTPConnection('127.0.0.1', self.gateway.server_port, timeout=3)) as c:
      headers = {'Content-Type': content_type, 'Cookie': cookie, 'X-API-Key': 'browser-forged-key'}
      if cookie != 'anonymous':
        headers['X-Company-Identity'] = urllib.parse.quote(json.dumps({'id': cookie, 'nickname': cookie, 'avatar': '🌷'}))
      c.request('POST' if body is not None else 'GET', path, body, headers)
      r = c.getresponse()
      return r.status, r.getheader('Content-Type'), r.read()

  def submit(self, **overrides):
    data = {'source_app': 'playground', 'client_request_id': 'action-1', 'prompt': 'a garden',
            'params': {'n': 1, 'size': '1024x1024', 'transparent_output': False}}
    data.update(overrides)
    return self.request('/api/image-jobs', json.dumps(data).encode())

  def test_capabilities_use_new_service_without_cookie_or_exposing_key(self):
    status, _, data = self.request('/api/image-capabilities')
    self.assertEqual(status, 200)
    self.assertEqual(json.loads(data)['max_input_images_per_job'], 1)
    call = self.calls[-1]
    self.assertEqual(call[1], '/v1/models')
    self.assertEqual(call[2]['X-API-Key'], 'server-only-key')
    self.assertNotIn('Cookie', call[2])
    self.assertNotIn(b'server-only-key', data)

  def test_json_submit_maps_identity_idempotency_and_params_once(self):
    status, _, data = self.submit(user_ref='forged')
    self.assertEqual(status, 202)
    calls = [c for c in self.calls if c[0] == 'POST']
    self.assertEqual(len(calls), 1)
    self.assertEqual(calls[0][1], '/v1/images/generations')
    self.assertEqual(calls[0][2]['Idempotency-Key'], 'action-1')
    payload = json.loads(calls[0][3])
    self.assertEqual(payload['user_ref'], 'company:alice')
    self.assertFalse(any(c[1] == '/api/identity' for c in self.calls))
    self.assertEqual(payload['external_ref'], 'action-1')
    self.assertEqual(payload['size'], '1024x1024')
    self.assertNotIn('transparent_output', payload)
    self.assertNotIn('storage_key', json.loads(data)['result_assets_json'][0])

  def test_multipart_edits_preserve_image_bytes_and_user(self):
    body = b''
    for name, value in [('prompt', 'a garden'), ('client_request_id', 'action-2'), ('source_app', 'playground'), ('params', '{"n":1}')]:
      body += f'--b\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    body += b'--b\r\nContent-Disposition: form-data; name="image"; filename="ref.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\x00\xff\r\n--b--\r\n'
    status, _, _ = self.request('/api/image-jobs', body, content_type='multipart/form-data; boundary=b')
    self.assertEqual(status, 202)
    call = self.calls[-1]
    self.assertEqual(call[1], '/v1/images/edits')
    fields, files = gallery.parse_multipart(call[2], call[3])
    self.assertEqual(fields['user_ref'], 'company:alice')
    self.assertEqual(files['image'][0]['data'], b'\x89PNG\x00\xff')

  def test_reference_limit_is_per_file_and_blocks_upstream(self):
    for size, expected in [(6, 202), (7, 413)]:
      with self.subTest(size=size), patch.object(gallery, 'MAX_REFERENCE_IMAGE_BYTES', 6):
        self.calls.clear()
        body = b''
        for name, value in [('prompt', 'garden'), ('client_request_id', 'limit-test'), ('source_app', 'playground')]:
          body += f'--b\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        for index in range(2):
          body += f'--b\r\nContent-Disposition: form-data; name="image"; filename="{index}.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + b'x' * size + b'\r\n'
        body += b'--b--\r\n'
        status, _, data = self.request('/api/image-jobs', body, content_type='multipart/form-data; boundary=b')
        self.assertEqual(status, expected)
        self.assertEqual(len([c for c in self.calls if c[0] == 'POST']), 1 if expected == 202 else 0)
        if expected == 413:
          self.assertIn('10 MB', json.loads(data)['detail'])

  def test_anonymous_submit_never_reaches_image_service(self):
    status, _, _ = self.request('/api/image-jobs', b'{}', cookie='anonymous')
    self.assertEqual(status, 401)
    self.assertEqual(self.calls, [])

  def test_unknown_company_identity_is_rejected_without_supplier_request(self):
    self.assertEqual(self.request('/api/image-jobs', b'{}', cookie='unknown')[0], 401)
    self.assertEqual(self.calls, [])

  def test_other_user_cannot_read_cancel_or_download_job(self):
    for path, body in [('/api/image-jobs/job-1', None), ('/api/image-jobs/job-1/cancel', b''), ('/api/image-jobs/job-1/results/0', None)]:
      self.assertEqual(self.request(path, body, cookie='bob')[0], 404)
    self.assertFalse(any(c[0] == 'POST' or '/result?' in c[1] for c in self.calls))

  def test_owner_reads_result_and_cancel(self):
    self.assertEqual(self.request('/api/image-jobs/job-1')[0], 200)
    status, mime, data = self.request('/api/image-jobs/job-1/results/0')
    self.assertEqual((status, mime, data), (200, 'image/png', b'PNG-output'))
    self.assertEqual(self.request('/api/image-jobs/job-1/cancel', b'')[0], 200)

  def test_upstream_error_is_returned_without_retry(self):
    self.mode = 'reject'
    status, _, data = self.submit()
    self.assertEqual(status, 503)
    self.assertEqual(json.loads(data)['detail'], 'service unavailable')
    self.assertEqual(len([c for c in self.calls if c[0] == 'POST']), 1)

  def test_non_json_upstream_500_is_not_misreported_as_bad_client_input(self):
    self.mode = 'plain_error'
    status, _, data = self.submit()
    self.assertEqual(status, 500)
    self.assertIn('独立生图服务', json.loads(data)['detail'])
    self.assertEqual(len([c for c in self.calls if c[0] == 'POST']), 1)

  def test_unsupported_parameter_is_not_silently_dropped(self):
    self.assertEqual(self.submit(params={'n': 1, 'transparent_output': True})[0], 400)
    self.assertFalse(any(c[0] == 'POST' for c in self.calls))


if __name__ == '__main__':
  unittest.main()
