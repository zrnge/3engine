#!/usr/bin/env python3
"""
Dev server for Tiny3.

Identical to `python -m http.server` except it tells the browser never to cache
anything. The stock server sends no cache headers at all, so Chrome will happily
keep serving an old `src/cameras.js` after you have edited it — the edit looks
like it did not work, and no amount of re-editing helps. A `?v=` query string on
the entry point does not help either, because the 20-odd modules it imports are
fetched under their own unversioned URLs.

    python serve.py            # http://localhost:8000
    python serve.py 3000       # another port
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # quieter than the default: skip the 200s, keep the failures
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = partial(NoCacheHandler, directory=".")
    with ThreadingHTTPServer(("", port), handler) as httpd:
        print(f"Tiny3 dev server  ->  http://localhost:{port}")
        print("Caching is disabled, so edits always take effect on reload.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
