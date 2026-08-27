#!/usr/bin/env python3
"""Reliquary local vault — static files + optional LLM proxy (127.0.0.1 only).

Ollama stays on this machine. xAI is proxied so the API key never has to live
in the browser. Prompts are not written to the Reliquary log.
"""
from __future__ import annotations

import errno
import json
import os
import posixpath
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8780"))
BIND = os.environ.get("RELIQUARY_BIND", "127.0.0.1")
XAI_BASE = os.environ.get("XAI_BASE_URL", "https://api.x.ai/v1").rstrip("/")
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
MAX_BODY = 2_000_000

XAI_MODELS = [
    {"id": "grok-4.6", "label": "grok-4.6 (flagship)"},
    {"id": "grok-4.5", "label": "grok-4.5"},
    {"id": "grok-4.3", "label": "grok-4.3 (cheaper)"},
]


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = val


load_dotenv(ROOT / ".env")
XAI_BASE = os.environ.get("XAI_BASE_URL", XAI_BASE).rstrip("/")
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", OLLAMA_HOST).rstrip("/")


def xai_key() -> str:
    return (os.environ.get("XAI_API_KEY") or "").strip()


def local_host(host_header: str) -> bool:
    host = (host_header or "").split(":")[0].strip().lower()
    return host in ("127.0.0.1", "localhost", "::1", "")


def upstream(url: str, method: str = "GET", headers: dict | None = None, body: bytes | None = None, timeout: float = 30):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as err:
        return err.code, err.read() if err.fp else b"", {k.lower(): v for k, v in (err.headers.items() if err.headers else [])}
    except Exception as err:  # noqa: BLE001 — surface any network failure as a proxy error
        return 0, str(err).encode("utf-8", "replace"), {}


def ollama_up() -> bool:
    code, _, _ = upstream(OLLAMA_HOST + "/api/tags", timeout=1.5)
    return 200 <= code < 300


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        # Never print request bodies / prompts.
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def _forbidden_path(self) -> bool:
        path = urlparse(self.path).path
        name = posixpath.basename(path).lower()
        if name.startswith(".env") or name in {".git", ".gitignore"}:
            return True
        parts = [p.lower() for p in path.split("/") if p]
        return ".git" in parts or "node_modules" in parts

    def _ensure_local(self) -> bool:
        if local_host(self.headers.get("Host", "")):
            return True
        self._json(403, {"ok": False, "error": "Reliquary only binds to localhost."})
        return False

    def _json(self, code: int, obj: dict) -> None:
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._json(400, {"ok": False, "error": "Request body missing or too large."})
            return None
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"ok": False, "error": "JSON required."})
            return None
        if not isinstance(data, dict):
            self._json(400, {"ok": False, "error": "JSON object required."})
            return None
        return data

    def do_GET(self) -> None:  # noqa: N802
        if not self._ensure_local():
            return
        if self._forbidden_path():
            self.send_error(404, "Not found")
            return
        parsed = urlparse(self.path)
        if parsed.path in ("/health", "/api/health"):
            self._json(200, {"ok": True})
            return
        if parsed.path == "/api/llm/status":
            self.handle_status()
            return
        if parsed.path == "/api/llm/models":
            self.handle_models(parsed)
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if not self._ensure_local():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/llm/chat":
            self.handle_chat()
            return
        self._json(404, {"ok": False, "error": "Not found"})

    def handle_status(self) -> None:
        ollama = ollama_up()
        key = bool(xai_key())
        self._json(
            200,
            {
                "ok": True,
                "proxy": True,
                "bind": BIND,
                "ollama": {"ok": ollama, "host": OLLAMA_HOST},
                "xai": {
                    "keyConfigured": key,
                    "baseUrl": XAI_BASE,
                    "keySource": "env" if key else None,
                },
            },
        )

    def handle_models(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        provider = (qs.get("provider") or ["ollama"])[0].strip().lower()
        if provider == "xai":
            models = list(XAI_MODELS)
            if xai_key():
                code, raw, _ = upstream(
                    XAI_BASE + "/models",
                    headers={"Authorization": "Bearer " + xai_key()},
                    timeout=8,
                )
                if 200 <= code < 300:
                    try:
                        data = json.loads(raw.decode("utf-8"))
                        ids = [
                            m.get("id")
                            for m in (data.get("data") or [])
                            if isinstance(m, dict) and str(m.get("id") or "").startswith("grok-")
                        ]
                        skip = ("imagine", "voice", "tts", "stt", "image", "video")
                        extra = [
                            {"id": i, "label": i}
                            for i in ids
                            if i and not any(s in i.lower() for s in skip)
                            and i not in {m["id"] for m in models}
                        ]
                        models.extend(extra)
                    except Exception:
                        pass
            self._json(200, {"ok": True, "provider": "xai", "models": models})
            return

        code, raw, _ = upstream(OLLAMA_HOST + "/api/tags", timeout=3)
        if not (200 <= code < 300):
            self._json(
                200,
                {
                    "ok": False,
                    "provider": "ollama",
                    "models": [],
                    "error": "Ollama is not reachable at %s. Install from https://ollama.com and pull an 8B+ instruct model."
                    % OLLAMA_HOST,
                },
            )
            return
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            data = {}
        models = []
        for m in data.get("models") or []:
            if not isinstance(m, dict):
                continue
            name = m.get("name") or m.get("model") or ""
            details = m.get("details") or {}
            models.append(
                {
                    "id": name,
                    "label": name,
                    "parameterSize": details.get("parameter_size") or "",
                    "family": details.get("family") or "",
                    "size": m.get("size") or 0,
                }
            )
        self._json(200, {"ok": True, "provider": "ollama", "models": models})

    def handle_chat(self) -> None:
        body = self._read_json()
        if body is None:
            return
        provider = str(body.get("provider") or "").strip().lower()
        model = str(body.get("model") or "").strip()
        messages = body.get("messages")
        if provider not in ("ollama", "xai"):
            self._json(400, {"ok": False, "error": "provider must be ollama or xai"})
            return
        if not model:
            self._json(400, {"ok": False, "error": "model is required"})
            return
        if not isinstance(messages, list) or not messages:
            self._json(400, {"ok": False, "error": "messages array is required"})
            return

        temperature = body.get("temperature", 0.2)
        try:
            temperature = float(temperature)
        except (TypeError, ValueError):
            temperature = 0.2

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "stream": False,
        }
        headers = {"Content-Type": "application/json"}
        timeout = 180.0

        if provider == "ollama":
            url = OLLAMA_HOST + "/v1/chat/completions"
        else:
            url = XAI_BASE + "/chat/completions"
            key = xai_key()
            if not key:
                auth = (self.headers.get("Authorization") or "").strip()
                if auth.lower().startswith("bearer "):
                    key = auth[7:].strip()
            if not key:
                self._json(
                    401,
                    {
                        "ok": False,
                        "error": "No xAI key. Put XAI_API_KEY in Reliquary/.env (preferred) or paste a key in Settings.",
                    },
                )
                return
            headers["Authorization"] = "Bearer " + key
            effort = str(body.get("reasoning_effort") or "low").strip()
            if effort:
                payload["reasoning_effort"] = effort

        raw_body = json.dumps(payload).encode("utf-8")
        self.log_message(
            "LLM %s %s %d messages %d bytes",
            provider,
            model,
            len(messages),
            len(raw_body),
        )
        code, raw, hdrs = upstream(url, method="POST", headers=headers, body=raw_body, timeout=timeout)
        if code == 0:
            self._json(502, {"ok": False, "error": "Upstream unreachable: " + raw.decode("utf-8", "replace")[:300]})
            return

        zdr = (hdrs.get("x-zero-data-retention") or "").lower() in ("1", "true", "yes")
        self.send_response(code if code >= 100 else 502)
        self.send_header("Content-Type", hdrs.get("content-type", "application/json; charset=utf-8"))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Reliquary-Provider", provider)
        if zdr:
            self.send_header("X-Reliquary-ZDR", "1")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main() -> None:
    if BIND not in ("127.0.0.1", "localhost", "::1"):
        print("Refusing to bind Reliquary off localhost.", file=sys.stderr)
        sys.exit(2)
    os.chdir(ROOT)
    try:
        httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    except OSError as err:
        busy = getattr(err, "errno", None) in (errno.EADDRINUSE, 48, 98, 10048)
        if busy:
            print("")
            print("  Reliquary could not start — port %s is already in use." % PORT)
            print("  If the vault is already open:  http://%s:%s" % (BIND, PORT))
            print("  If that page is dead, stop the old process and try again:")
            print("    lsof -ti :%s | xargs kill" % PORT)
            print("")
            sys.exit(1)
        raise
    httpd.daemon_threads = True
    print("")
    print("  Reliquary — writing archaeology")
    print("  Open: http://%s:%s" % (BIND, PORT))
    print("  Stop: Ctrl+C")
    print("")
    print("  Optional AI is off until you set it in Settings.")
    if xai_key():
        print("  xAI:    key loaded from .env — drafts leave this machine when you use Grok")
    else:
        print("  xAI:    no XAI_API_KEY in .env yet (optional — Settings explains how)")
    print("")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
