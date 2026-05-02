import http.server
import os

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not os.path.isfile(path):
            html_path = path + ".html"
            if os.path.isfile(html_path):
                self.path = self.path.rstrip("/") + ".html"
        super().do_GET()

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    http.server.test(HandlerClass=Handler, port=5000, bind="0.0.0.0")
