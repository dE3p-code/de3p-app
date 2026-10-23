"""Kleine Notion-API helper (raw REST) voor de schema-scripts."""

from __future__ import annotations

import os
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
except Exception:
    load_dotenv = None

BASE = Path(__file__).resolve().parent
ENV_PATH = BASE / ".env"
API = "https://api.notion.com/v1"
VERSION = "2022-06-28"


def _load_env() -> None:
    if load_dotenv and ENV_PATH.exists():
        load_dotenv(ENV_PATH)


def token() -> str:
    _load_env()
    t = os.getenv("NOTION_TOKEN", "").strip()
    if not t:
        raise SystemExit("NOTION_TOKEN ontbreekt in .env")
    return t


def page_id() -> str:
    _load_env()
    return os.getenv("NOTION_PAGE_ID", "").strip()


def _headers() -> dict:
    return {"Authorization": f"Bearer {token()}",
            "Notion-Version": VERSION, "Content-Type": "application/json"}


# --------------------------------------------------------------------------- #
# Lezen
# --------------------------------------------------------------------------- #
def get_children(block_id: str) -> list[dict]:
    out, cursor = [], None
    while True:
        params = {"page_size": 100}
        if cursor:
            params["start_cursor"] = cursor
        r = requests.get(f"{API}/blocks/{block_id}/children",
                         headers=_headers(), params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        out.extend(data["results"])
        if not data.get("has_more"):
            return out
        cursor = data["next_cursor"]


def plain(block: dict) -> str:
    btype = block.get("type", "")
    rich = block.get(btype, {}).get("rich_text", [])
    return "".join(x.get("plain_text", "") for x in rich)


def child_page_title(block: dict) -> str:
    return block.get("child_page", {}).get("title", "") if block.get("type") == "child_page" else ""


# --------------------------------------------------------------------------- #
# Schrijven
# --------------------------------------------------------------------------- #
def append_children(block_id: str, children: list[dict], after: str | None = None) -> dict:
    body: dict = {"children": children}
    if after:
        body["after"] = after
    r = requests.patch(f"{API}/blocks/{block_id}/children",
                       headers=_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def delete_block(block_id: str) -> None:
    r = requests.delete(f"{API}/blocks/{block_id}", headers=_headers(), timeout=30)
    r.raise_for_status()


def update_block(block_id: str, payload: dict) -> None:
    r = requests.patch(f"{API}/blocks/{block_id}", headers=_headers(), json=payload, timeout=30)
    r.raise_for_status()


def create_subpage(parent_page_id: str, title: str, children: list[dict],
                   icon_emoji: str | None = None) -> dict:
    body = {
        "parent": {"page_id": parent_page_id},
        "properties": {"title": {"title": [{"type": "text", "text": {"content": title}}]}},
        "children": children,
    }
    if icon_emoji:
        body["icon"] = {"type": "emoji", "emoji": icon_emoji}
    r = requests.post(f"{API}/pages", headers=_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json()


# --------------------------------------------------------------------------- #
# Block-bouwers
# --------------------------------------------------------------------------- #
def rt(text: str, bold: bool = False) -> list[dict]:
    return [{"type": "text", "text": {"content": text[:1990]},
             "annotations": {"bold": bold}}]


def rt_focus(focus_text: str) -> list[dict]:
    return [
        {"type": "text", "text": {"content": "Focus: "}, "annotations": {"bold": True}},
        {"type": "text", "text": {"content": focus_text[:1900]}},
    ]


def heading2(text: str) -> dict:
    return {"object": "block", "type": "heading_2",
            "heading_2": {"rich_text": rt(text)}}


def quote(rich: list[dict]) -> dict:
    return {"object": "block", "type": "quote", "quote": {"rich_text": rich}}


def paragraph(rich: list[dict]) -> dict:
    return {"object": "block", "type": "paragraph", "paragraph": {"rich_text": rich}}


def divider() -> dict:
    return {"object": "block", "type": "divider", "divider": {}}


def table_row(cells_text: list[str]) -> dict:
    return {"object": "block", "type": "table_row",
            "table_row": {"cells": [rt(c) for c in cells_text]}}


def table(header: list[str], rows: list[list[str]]) -> dict:
    width = len(header)
    children = [table_row(header)] + [table_row(r) for r in rows]
    return {"object": "block", "type": "table",
            "table": {"table_width": width, "has_column_header": True,
                      "has_row_header": False, "children": children}}
