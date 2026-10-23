"""
Gsm-app dE3p: na elke sync een versleutelde kopie van wat het programma toont naar www.de3p.be,
zodat je gsm dezelfde schermen kan tonen (trainingen, schema, kaarten en gezondheid).

Alles wordt hier op de computer versleuteld (AES-256-GCM) met een sleutel die enkel deze computer
en je gsm kennen. Die sleutel gaat naar je gsm via een korte koppelcode (XXXX-XXXX) die je zelf
intypt: de website krijgt enkel een hash van de code en een pakketje dat met de code zelf versleuteld
is. dE3p kan je gegevens dus niet lezen. Er wordt enkel iets verstuurd als er iets veranderde.
"""
from __future__ import annotations

import base64
import datetime as dt
import gzip
import hashlib
import io
import json
import os
import secrets
import threading
from pathlib import Path

import requests

import userdata

API = os.environ.get("DE3P_API", "https://www.de3p.be/api")
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"     # geen 0/O, 1/I/L: makkelijk over te typen
CARD_DAYS = 26 * 7                               # kaarten van de laatste 6 maanden, zoals in het programma
CARD_MAX_NEW = 30                                # per keer, zodat de eerste keer niet eindeloos duurt
CODE_TTL = 7 * 86400                             # een koppelcode werkt 7 dagen, verlengd bij elke sync
_lock = threading.Lock()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _encrypt(key: bytes, data: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = secrets.token_bytes(12)
    return b"D3P1" + nonce + AESGCM(key).encrypt(nonce, data, None)


def _decrypt(key: bytes, blob: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if len(blob) < 32 or blob[:4] != b"D3P1":
        raise ValueError("onbekend formaat")
    return AESGCM(key).decrypt(blob[4:16], blob[16:], None)


def inbox() -> list[dict]:
    """Wat de gsm klaarlegde voor deze computer (bv. een nieuw doel): [{oid, op, id, ...}], of [].
    Enkel wat met de gedeelde sleutel versleuteld is telt; de rest wordt genegeerd."""
    if not paired():
        return []
    p = info()
    r = requests.get(f"{API}/spiegel/{p['id']}/in", headers={"X-Schrijf": p["w"]}, timeout=20)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    try:
        data = json.loads(_decrypt(_unb64(p["key"]), r.content))
    except Exception:
        return []
    ops = data.get("ops") if isinstance(data, dict) else None
    return [o for o in ops if isinstance(o, dict)] if isinstance(ops, list) else []


def clear_inbox() -> None:
    if paired():
        p = info()
        requests.delete(f"{API}/spiegel/{p['id']}/in", headers={"X-Schrijf": p["w"]}, timeout=20)


def info() -> dict:
    return userdata.load().get("phone") or {}


def paired() -> bool:
    p = info()
    return bool(p.get("id") and p.get("key") and p.get("w"))


def status() -> dict:
    p = info()
    return {"paired": paired(), "last": p.get("last", ""), "error": p.get("error", "")}


def _post_code(p: dict, code: str) -> None:
    """Pakketje voor de code klaarzetten (of verlengen) op de website, 7 dagen geldig."""
    look = hashlib.sha256(f"dE3p-zoek:{code}".encode()).hexdigest()
    k = hashlib.pbkdf2_hmac("sha256", code.encode(), b"dE3p-koppel", 200_000, 32)
    blob = _b64(_encrypt(k, json.dumps({"id": p["id"], "key": p["key"]}).encode()))
    r = requests.post(f"{API}/paar", json={"look": look, "blob": blob, "ttl": CODE_TTL}, timeout=20)
    r.raise_for_status()


def pair(new: bool = False) -> dict:
    """Koppelcode voor je gsm. Altijd dezelfde zolang ze geldig is (7 dagen, verlengd bij elke sync),
    zodat je ze opnieuw kan gebruiken op een andere gsm of als de app leeg begint. new=True: nieuwe code.
    De eerste keer krijgt deze computer ook zijn sleutel."""
    p = info()
    if not paired():
        p = {"id": secrets.token_hex(16), "key": _b64(secrets.token_bytes(32)), "w": secrets.token_urlsafe(32)}
    code = "" if new else p.get("code", "")
    if not code:
        code = "".join(secrets.choice(ALPHABET) for _ in range(8))
    _post_code(p, code)
    p = {**p, "code": code, "code_at": dt.date.today().isoformat()}
    userdata.update(phone=p)
    return {"code": f"{code[:4]}-{code[4:]}", "url": f"https://www.de3p.be/?koppel={code}", "days": CODE_TTL // 86400}


def unpair() -> None:
    """Gsm ontkoppelen: de kopie op de website wissen en een nieuwe sleutel bij een volgende koppeling."""
    p = info()
    if paired():
        try:
            requests.delete(f"{API}/spiegel/{p['id']}", headers={"X-Schrijf": p["w"]}, timeout=20)
        except requests.RequestException:
            pass
    userdata.update(phone=None)


def _small_card(path: Path) -> bytes:
    """Kaart verkleind tot gsm-formaat (JPEG, ±100 kB)."""
    from PIL import Image
    im = Image.open(path).convert("RGB")
    im.thumbnail((720, 1280), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82, optimize=True)
    return buf.getvalue()


def push(state: dict, extra: dict, force: bool = False) -> str:
    """Kopie + nieuwe kaarten versturen. 'ok', 'same' (niets veranderd) of 'off' (niet gekoppeld).
    force: ook als er niets veranderde (de gsm vroeg om Bijwerken en wacht op een nieuwe kopie)."""
    with _lock:
        if not paired():
            return "off"
        p = info()
        key = _unb64(p["key"])
        hdr = {"X-Schrijf": p["w"]}
        done = set(p.get("cards") or [])
        since = (dt.date.today() - dt.timedelta(days=CARD_DAYS)).isoformat()
        st = json.loads(json.dumps(state))
        cards, new = {}, 0
        try:
            for day, lst in sorted((st.get("cards") or {}).items(), reverse=True):
                if day < since:
                    continue
                out = []
                for c in lst:
                    f = Path(c["path"])
                    try:
                        stamp = f"{f.name}|{f.stat().st_mtime_ns}|{p['id']}"
                    except OSError:
                        continue
                    name = hashlib.sha256(stamp.encode()).hexdigest()[:24]
                    if name not in done:
                        if new >= CARD_MAX_NEW:
                            continue                       # volgende keer verder
                        r = requests.put(f"{API}/spiegel/{p['id']}/k/{name}", data=_encrypt(key, _small_card(f)), headers=hdr, timeout=60)
                        r.raise_for_status()
                        done.add(name)
                        new += 1
                    out.append({"path": f"pc:{name}", "name": c["name"]})
                if out:
                    cards[day] = out
            st["cards"] = cards
            st["cardsDir"] = ""
            st.pop("generated", None)
            body = {"v": 1, "state": st, **extra}
            raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False, sort_keys=True).encode()
            h = hashlib.sha256(raw).hexdigest()
            now = dt.datetime.now().isoformat(timespec="minutes")
            today = dt.date.today().isoformat()
            if p.get("code") and p.get("code_at") != today:   # code blijft geldig zolang de computer synct
                try:
                    _post_code(p, p["code"])
                    p = {**p, "code_at": today}
                except requests.RequestException:
                    pass
            if h == p.get("hash") and not force:
                userdata.update(phone={**p, "cards": sorted(done)[-600:], "error": ""})
                return "same"
            body["made"] = now
            raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
            r = requests.put(f"{API}/spiegel/{p['id']}", data=_encrypt(key, gzip.compress(raw, 6)), headers=hdr, timeout=90)
            r.raise_for_status()
            userdata.update(phone={**p, "hash": h, "cards": sorted(done)[-600:], "last": now, "error": ""})
            return "ok"
        except Exception as exc:
            userdata.update(phone={**info(), "cards": sorted(done)[-600:], "error": type(exc).__name__})
            raise
