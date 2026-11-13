"""Local preview server that serves URLs the way the Cloudflare Worker assets do.

- /commercial  -> commercial.html  (Cloudflare's automatic .html handling)
- /project/... and any other unknown page route -> index.html (single-page-application fallback)
- real files (images, js, ...) are served as-is; missing /images/... still 404 so broken paths show up

Threaded, so parallel image requests don't stall (see plain http.server issues).
Run from the repo root:  python3 .claude/dev-server.py [port]
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _rewrite(self):
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        local = os.path.join(ROOT, path.lstrip("/"))
        if path != "/" and os.path.isfile(local):
            return
        if path.endswith(".html") or path == "/":
            return
        stripped = path.rstrip("/")
        if os.path.isfile(os.path.join(ROOT, stripped.lstrip("/") + ".html")):
            new = stripped + ".html"
        elif "." in os.path.basename(path):
            return  # a missing asset: let it 404
        else:
            new = "/index.html"
        self.path = new + ("?" + parts.query if parts.query else "")

    def do_GET(self):
        self._rewrite()
        super().do_GET()

    def do_HEAD(self):
        self._rewrite()
        super().do_HEAD()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"Serving {ROOT} at http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("localhost", port), Handler).serve_forever()
