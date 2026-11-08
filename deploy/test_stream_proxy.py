import http.client
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import ai_gallery_server as gallery


class StreamProxyTests(unittest.TestCase):
  def test_multipart_overrides_duplicates_and_inserts_missing_fields(self):
    body = b'--test\r\nContent-Disposition: form-data; name="model"\r\n\r\nold\r\n--test\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n--test--\r\n'
    body, ok = gallery.replace_multipart_field(body, 'multipart/form-data; boundary="test"', 'model', 'new')
    self.assertTrue(ok)
    self.assertNotIn(b'old', body)
    self.assertNotIn(b'other', body)
    body, ok = gallery.replace_multipart_field(body, 'multipart/form-data; boundary=test', 'stream', 'true')
    fields, _ = gallery.parse_multipart({'Content-Type': 'multipart/form-data; boundary=test'}, body)
    self.assertTrue(ok)
    self.assertEqual(fields['stream'], 'true')
    self.assertEqual(fields['model'], 'new')

  def test_event_url_rewrite(self):
    event = b'event: image_edit.completed\r\nid: 1\r\ndata: {"type":"image_edit.completed","url":"https://image.example/a.png"}'
    result = gallery.rewrite_sse_event(event, 'http://local')
    self.assertIn(b'event: image_edit.completed', result)
    self.assertIn(b'id: 1', result)
    self.assertIn(b'http://local/api/image-fetch?', result)
    self.assertEqual(gallery.rewrite_sse_event(b': heartbeat', 'http://local'), b': heartbeat\n\n')

  def test_real_http_stream_and_error_passthrough(self):
    release = threading.Event()
    captured = []

    class Upstream(BaseHTTPRequestHandler):
      def log_message(self, *args):
        pass

      def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        if 'multipart' in self.headers['Content-Type']:
          fields, _ = gallery.parse_multipart(self.headers, body)
        else:
          fields = json.loads(body)
        captured.append(fields)
        if fields.get('prompt') == 'fail':
          self.send_response(524)
          self.send_header('CF-Ray', 'test-ray')
          self.end_headers()
          self.wfile.write(b'A timeout occurred')
          return
        if fields.get('prompt') == 'json':
          self.send_response(200)
          self.send_header('Content-Type', 'application/json')
          self.end_headers()
          self.wfile.write(b'{"data":[{"b64_json":"aW1hZ2U="}]}')
          return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(b': heartbeat\r\n\r\n')
        self.wfile.flush()
        release.wait(4)
        # 刻意拆开网络块，验证事件边界不会被破坏。
        self.wfile.write(b'data: {"type":"image_edit.completed",')
        self.wfile.flush()
        self.wfile.write(b'"url":"https://image.example/a.png"}\r\n\r\ndata: [DONE]\n\n')

    upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    proxy = ThreadingHTTPServer(('127.0.0.1', 0), gallery.Handler)
    for server in (upstream, proxy):
      threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
      with patch.multiple(gallery, UPSTREAM_URL=f'http://127.0.0.1:{upstream.server_port}', UPSTREAM_KEY='test-only', UPSTREAM_MODEL='server-model', STREAM_IMAGES=True):
        conn = http.client.HTTPConnection('127.0.0.1', proxy.server_port, timeout=2)
        conn.request('POST', '/api-proxy/images/generations', json.dumps({'model': 'ignored', 'stream': False}), {'Content-Type': 'application/json'})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIsNone(response.getheader('Content-Length'))
        self.assertTrue(response.getheader('X-Request-ID'))
        # 上游未结束时必须读到心跳，否则超时失败。
        self.assertEqual(response.readline(), b': heartbeat\n')
        self.assertEqual(response.readline(), b'\n')
        self.assertFalse(release.is_set())
        release.set()
        result = response.read()
        self.assertIn(b'/api/image-fetch?', result)
        self.assertIn(b'data: [DONE]', result)
        self.assertEqual(captured[0]['model'], 'server-model')
        self.assertIs(captured[0]['stream'], True)
        conn.close()

        for prompt, status in [('fail', 524), ('json', 200)]:
          conn = http.client.HTTPConnection('127.0.0.1', proxy.server_port, timeout=2)
          body = f'--test\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n{prompt}\r\n--test--\r\n'.encode()
          conn.request('POST', '/api-proxy/images/edits', body, {'Content-Type': 'multipart/form-data; boundary=test'})
          response = conn.getresponse()
          self.assertEqual(response.status, status)
          if status == 524:
            self.assertEqual(response.getheader('CF-Ray'), 'test-ray')
          response.read()
          self.assertEqual(captured[-1]['stream'], 'true')
          self.assertEqual(captured[-1]['model'], 'server-model')
          conn.close()
    finally:
      release.set()
      for server in (proxy, upstream):
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
  unittest.main()
