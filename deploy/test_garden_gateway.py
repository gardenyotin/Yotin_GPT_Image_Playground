"""仅用本地假 Garden 检查部署网关；不请求真实供应商。"""
import http.client
import http.server
import json
import threading
import unittest
from unittest.mock import patch

import ai_gallery_server as gallery


class GardenGatewayTests(unittest.TestCase):
  def setUp(self):
    self.received = []
    received = self.received

    class Garden(http.server.BaseHTTPRequestHandler):
      def do_GET(self):
        self.handle_request()

      def do_POST(self):
        self.handle_request()

      def handle_request(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        received.append((self.command, self.path, dict(self.headers), body))
        self.send_response(202 if self.command == 'POST' else 200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Set-Cookie', 'youting_session=test; HttpOnly; SameSite=Strict; Path=/')
        self.end_headers()
        self.wfile.write(b'{"job_id":"garden-job","status":"queued"}')

      def log_message(self, *_args):
        pass

    self.garden = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Garden)
    self.gateway = http.server.ThreadingHTTPServer(('127.0.0.1', 0), gallery.Handler)
    self.config = patch.object(gallery, 'GARDEN_API_URL', f'http://127.0.0.1:{self.garden.server_port}')
    self.config.start()
    self.threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (self.garden, self.gateway)]
    for thread in self.threads:
      thread.start()

  def tearDown(self):
    for server in (self.gateway, self.garden):
      server.shutdown()
      server.server_close()
    for thread in self.threads:
      thread.join(timeout=2)
    self.config.stop()

  def request(self, path, body=None, headers=None):
    with http.client.HTTPConnection('127.0.0.1', self.gateway.server_port, timeout=3) as conn:
      conn.request('POST' if body is not None else 'GET', path, body, headers or {})
      response = conn.getresponse()
      return response.status, dict(response.getheaders()), response.read()

  def test_cookie_and_multipart_are_forwarded_once_unchanged(self):
    body = b'--boundary\r\nContent-Disposition: form-data; name="image"; filename="ref.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\xff\x00\r\n--boundary--\r\n'
    status, headers, data = self.request('/api/image-jobs', body, {'Content-Type': 'multipart/form-data; boundary=boundary', 'Cookie': 'youting_session=test'})
    self.assertEqual(status, 202)
    self.assertEqual(len(self.received), 1)
    self.assertEqual(self.received[0][1], '/api/image-jobs')
    self.assertEqual(self.received[0][2]['Cookie'], 'youting_session=test')
    self.assertNotIn('Authorization', self.received[0][2])
    self.assertEqual(self.received[0][3], body)
    self.assertIn('HttpOnly', headers['Set-Cookie'])
    self.assertEqual(json.loads(data)['job_id'], 'garden-job')

  def test_results_and_auth_routes_keep_the_api_prefix(self):
    for path in ('/api/image-capabilities', '/api/image-jobs/job/results/0', '/api/identity'):
      self.assertEqual(self.request(path)[0], 200)
      self.assertEqual(self.received[-1][1], path)
    self.assertEqual(self.request('/api/auth/login', b'{}', {'Content-Type': 'application/json'})[0], 202)

  def test_retired_image_endpoints_and_builtin_tools_never_go_outbound(self):
    for path in ('/api-proxy/images/generations', '/api-proxy/images/edits'):
      self.assertEqual(self.request(path, b'{}')[0], 410)
    for tool in ({'type': 'image_generation'}, {'type': 'image_generation', 'model': 'anything'}):
      body = json.dumps({'model': 'text', 'tools': [tool]}).encode()
      self.assertEqual(self.request('/api-proxy/responses', body)[0], 422)
    self.assertEqual(self.received, [])

  def test_unconfigured_garden_fails_without_fallback(self):
    with patch.object(gallery, 'GARDEN_API_URL', ''):
      self.assertEqual(self.request('/api/image-jobs', b'{}')[0], 503)
    self.assertEqual(self.received, [])


if __name__ == '__main__':
  unittest.main()
