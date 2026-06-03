"""WebComicTranslate 日志服务器 - 接收扩展 POST 的日志，写入本地文件"""
import http.server
import json
import sys
from datetime import datetime

LOG_FILE = "debug.log"

class LogHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8')
        try:
            data = json.loads(body)
            ts = datetime.now().strftime('%H:%M:%S.%f')[:-3]
            msg = data.get('msg', body)
            level = data.get('level', 'INFO')
            line = f"[{ts}] [{level}] {msg}\n"
            with open(LOG_FILE, 'a', encoding='utf-8') as f:
                f.write(line)
            print(line, end='')
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
        except Exception as e:
            print(f"Error: {e}")
            self.send_response(400)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        pass  # 静默 HTTP 日志

if __name__ == '__main__':
    port = 8765
    print(f"WebComicTranslate 日志服务器启动: http://localhost:{port}")
    print(f"日志文件: {LOG_FILE}")
    http.server.HTTPServer(('127.0.0.1', port), LogHandler).serve_forever()
