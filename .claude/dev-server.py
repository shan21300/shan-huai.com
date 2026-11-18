"""Local preview server that serves URLs the way the Cloudflare Worker assets do.

- /commercial  -> commercial.html  (Cloudflare's automatic .html handling)
- /project/... and any other unknown page route -> index.html (single-page-application fallback)
- real files (images, js, ...) are served as-is; missing /images/... still 404 so broken paths show up
- local-only draft preview: any URL with ?draft=<name> (e.g. ?draft=credits-draft) makes / and every
  SPA route serve <name>.html instead of index.html for this browser (cookie), so clicking through
  from /commercial or /personal stays on the draft. ?draft= (empty) turns it off.

Threaded, so parallel image requests don't stall (see plain http.server issues).
Run from the repo root:  python3 .claude/dev-server.py [port]
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import re
from urllib.parse import urlsplit, unquote, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _draft(self, parts):
        """the draft file to serve in place of index.html (or None); ?draft= sets/clears it"""
        self._set_cookie = None
        q = parse_qs(parts.query, keep_blank_values=True)
        if "draft" in q:
            name = q["draft"][0]
            ok = re.fullmatch(r"[A-Za-z0-9_-]+", name) and os.path.isfile(os.path.join(ROOT, name + ".html"))
            self._set_cookie = "preview_draft=" + (name if ok else "") + "; Path=/" + ("" if ok else "; Max-Age=0")
            return name if ok else None
        m = re.search(r"(?:^|;\s*)preview_draft=([A-Za-z0-9_-]+)", self.headers.get("Cookie", ""))
        if m and os.path.isfile(os.path.join(ROOT, m.group(1) + ".html")):
            return m.group(1)
        return None

    def end_headers(self):
        if getattr(self, "_set_cookie", None):
            self.send_header("Set-Cookie", self._set_cookie)
        super().end_headers()

    def _rewrite(self):
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        draft = self._draft(parts)
        local = os.path.join(ROOT, path.lstrip("/"))
        if path != "/" and os.path.isfile(local):
            return
        if path == "/" and draft:
            self.path = "/" + draft + ".html" + ("?" + parts.query if parts.query else "")
            return
        if path.endswith(".html") or path == "/":
            return
        stripped = path.rstrip("/")
        if os.path.isfile(os.path.join(ROOT, stripped.lstrip("/") + ".html")):
            new = stripped + ".html"
        elif "." in os.path.basename(path):
            return  # a missing asset: let it 404
        else:
            new = "/" + draft + ".html" if draft else "/index.html"
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
