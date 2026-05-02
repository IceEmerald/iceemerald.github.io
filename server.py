import http.server
import os
from urllib.parse import urlparse

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        clean_path = parsed.path
        disk_path = self.translate_path(clean_path)
        if not os.path.exists(disk_path) or not os.path.isfile(disk_path):
            html_disk = self.translate_path(clean_path.rstrip("/") + ".html")
            if os.path.isfile(html_disk):
                self.path = clean_path.rstrip("/") + ".html"
                if parsed.query:
                    self.path += "?" + parsed.query
        super().do_GET()

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    http.server.test(HandlerClass=Handler, port=5000, bind="0.0.0.0")
