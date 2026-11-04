# 開発用のローカルサーバー。ブラウザに古いファイルを使わせないよう、キャッシュしない指示をつけて配る。
# 使い方：このフォルダで  python serve.py   （同じWi-Fiの iPhone / iPad から http://<このPCのIP>:8000/ で開く）
import http.server
import socketserver


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    with Server(('0.0.0.0', 8000), NoCacheHandler) as httpd:
        print('http://localhost:8000/ で起動しました（Ctrl+C で止める）')
        httpd.serve_forever()
