"""Local static server for App Installer integration tests (single byte ranges + HEAD)."""
from __future__ import annotations

import argparse
import mimetypes
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

mimetypes.add_type('application/msix', '.msix')
mimetypes.add_type('application/appinstaller', '.appinstaller')
_RANGE = re.compile(r'^bytes=(\d*)-(\d*)$')


class RangeRequestHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, directory: str, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def do_HEAD(self):
        self._serve_file(head_only=True)

    def do_GET(self):
        self._serve_file(head_only=False)

    def _serve_file(self, *, head_only: bool):
        path = Path(self.translate_path(self.path))
        if not path.is_file():
            self.send_error(404, 'Not found')
            return
        size = path.stat().st_size
        start, end, partial = 0, size - 1, False
        value = self.headers.get('Range')
        if value:
            match = _RANGE.fullmatch(value.strip())
            if not match or not size:
                self._range_not_satisfiable(size)
                return
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            elif last:
                suffix = int(last)
                if suffix <= 0:
                    self._range_not_satisfiable(size)
                    return
                start = max(0, size - suffix)
            else:
                self._range_not_satisfiable(size)
                return
            if start >= size or start > end:
                self._range_not_satisfiable(size)
                return
            partial = True

        length = max(0, end - start + 1)
        self.send_response(206 if partial else 200)
        self.send_header('Content-Type', self.guess_type(str(path)))
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        if partial:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        if head_only or not length:
            return
        with path.open('rb') as media:
            media.seek(start)
            remaining = length
            while remaining:
                chunk = media.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _range_not_satisfiable(self, size: int):
        self.send_response(416)
        self.send_header('Content-Range', f'bytes */{size}')
        self.send_header('Content-Length', '0')
        self.end_headers()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.bind, args.port),
                                 lambda *a, **kw: RangeRequestHandler(*a, directory=args.directory, **kw))
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
