"""
Eenmalige helper: haalt je Strava refresh token op via OAuth en schrijft die
naar .env.

Vooraf (eenmalig op https://www.strava.com/settings/api):
  - Maak een API-applicatie aan.
  - Zet "Authorization Callback Domain" op:  localhost
  - Noteer Client ID en Client Secret.

Vul Client ID/Secret in .env (kopieer .env.example) en run dan:
  python get_strava_token.py

Er opent een browser; klik "Authorize". De pagina vangt de redirect op,
wisselt de code om voor tokens en schrijft STRAVA_REFRESH_TOKEN naar .env.
"""

from __future__ import annotations

import os
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import requests

try:
    from dotenv import load_dotenv
except Exception:
    load_dotenv = None

BASE = Path(__file__).resolve().parent
ENV_PATH = BASE / ".env"
PORT = 8721
REDIRECT_URI = f"http://localhost:{PORT}/callback"
SCOPE = "activity:read_all,activity:write"

_code: str | None = None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        global _code
        qs = parse_qs(urlparse(self.path).query)
        _code = qs.get("code", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        msg = "Gelukt! Je kan dit tabblad sluiten." if _code else "Geen code ontvangen."
        self.wfile.write(f"<h2>{msg}</h2>".encode("utf-8"))

    def log_message(self, *args):  # stil
        pass


def update_env_var(key: str, value: str) -> None:
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    out, found = [], False
    for ln in lines:
        if ln.strip().startswith(f"{key}="):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(ln)
    if not found:
        out.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(out) + "\n", encoding="utf-8")


def main() -> None:
    if load_dotenv and ENV_PATH.exists():
        load_dotenv(ENV_PATH)
    client_id = os.getenv("STRAVA_CLIENT_ID", "").strip()
    client_secret = os.getenv("STRAVA_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        sys.exit("Zet eerst STRAVA_CLIENT_ID en STRAVA_CLIENT_SECRET in .env "
                 "(kopieer .env.example).")

    auth_url = (
        "https://www.strava.com/oauth/authorize"
        f"?client_id={client_id}&response_type=code&redirect_uri={REDIRECT_URI}"
        f"&approval_prompt=force&scope={SCOPE}"
    )
    print("Open deze URL en klik 'Authorize' (browser opent automatisch):\n")
    print(auth_url, "\n")
    webbrowser.open(auth_url)

    server = HTTPServer(("localhost", PORT), Handler)
    print(f"Wachten op redirect op {REDIRECT_URI} ...")
    while _code is None:
        server.handle_request()

    print("Code ontvangen, tokens ophalen ...")
    r = requests.post("https://www.strava.com/oauth/token", data={
        "client_id": client_id,
        "client_secret": client_secret,
        "code": _code,
        "grant_type": "authorization_code",
    }, timeout=30)
    r.raise_for_status()
    data = r.json()
    refresh = data["refresh_token"]
    update_env_var("STRAVA_REFRESH_TOKEN", refresh)
    print("\nKlaar! STRAVA_REFRESH_TOKEN is naar .env geschreven.")
    print(f"Athleet: {data.get('athlete', {}).get('firstname', '?')} | scope: {SCOPE}")
    print("Test nu:  python strava_sync.py --once --dry-run")


if __name__ == "__main__":
    main()
