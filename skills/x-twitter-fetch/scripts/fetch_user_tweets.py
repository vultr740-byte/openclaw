#!/usr/bin/env python3
"""Fetch user timeline with ordered fallback.

Default provider order:
1) r.jina.ai profile snapshot
2) twitter-viewer API (supports cursor pagination)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

VIEWER_BASE_URL = "https://www.twitter-viewer.com/api/x/user-tweets"
JINA_BASE_URL = "https://r.jina.ai/http://x.com"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
REFERER = "https://www.twitter-viewer.com/"
DEFAULT_PROVIDERS = "jina,twitter-viewer"

STATUS_URL_RE = re.compile(
    r"https?://(?:x\.com|twitter\.com)/(?P<user>[A-Za-z0-9_]+)/status/(?P<id>\d+)",
    re.IGNORECASE,
)


class FetchError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        attempts: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.attempts = attempts or []


def _clean_username(username: str) -> str:
    clean = username.strip()
    if clean.startswith("@"):
        clean = clean[1:]
    return clean


def _build_viewer_url(username: str, cursor: str, base_url: str) -> str:
    clean = _clean_username(username)
    params = {"username": clean, "cursor": cursor or ""}
    return f"{base_url}?{urllib.parse.urlencode(params)}"


def _build_jina_url(username: str, jina_base: str) -> str:
    clean = _clean_username(username)
    return f"{jina_base.rstrip('/')}/{clean}"


def _build_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener()


def _fetch_text(url: str, timeout: float) -> tuple[str, int]:
    headers = {
        "accept": "application/json, text/plain, */*;q=0.9",
        "user-agent": USER_AGENT,
        "referer": REFERER,
    }
    req = urllib.request.Request(url, headers=headers)
    opener = _build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
            status = int(getattr(resp, "status", 200))
            body = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise FetchError(f"HTTP {exc.code}: {detail}".strip(), status=int(exc.code)) from exc
    except Exception as exc:
        raise FetchError(str(exc)) from exc
    return body.decode("utf-8", errors="replace"), status


def _fetch_json(url: str, timeout: float) -> tuple[dict[str, Any], int]:
    text, status = _fetch_text(url, timeout)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise FetchError("Response was not valid JSON") from exc
    if not isinstance(payload, dict):
        raise FetchError("JSON root is not an object")
    return payload, status


def _normalize_from_viewer(
    payload: dict[str, Any],
    *,
    username: str,
    cursor: str,
    source_url: str,
) -> dict[str, Any]:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    user = data.get("user") if isinstance(data.get("user"), dict) else {}
    tweets = data.get("tweets") if isinstance(data.get("tweets"), list) else []
    pagination = data.get("pagination") if isinstance(data.get("pagination"), dict) else {}
    return {
        "source_tier": "mirror_api",
        "source_name": "twitter-viewer",
        "confidence": "medium",
        "source_url": source_url,
        "username": _clean_username(username),
        "cursor": cursor or "",
        "data": {
            "user": user,
            "tweets": tweets,
            "pagination": pagination,
        },
        "raw": payload,
    }


def _normalize_from_jina(
    markdown: str,
    *,
    username: str,
    source_url: str,
) -> dict[str, Any]:
    target = _clean_username(username).lower()
    lines = markdown.splitlines()
    tweets: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, line in enumerate(lines):
        match = STATUS_URL_RE.search(line)
        if not match:
            continue
        owner = (match.group("user") or "").lower()
        if owner and owner != target:
            continue
        tid = match.group("id")
        if tid in seen:
            continue
        seen.add(tid)
        url = f"https://x.com/{owner or target}/status/{tid}"

        # Best-effort text: use the nearest non-empty previous line if available.
        text = ""
        for prev_index in range(index - 1, -1, -1):
            candidate = lines[prev_index].strip()
            if not candidate:
                continue
            if candidate.lower().startswith("http"):
                continue
            text = candidate
            break

        record: dict[str, str] = {"id": tid, "url": url}
        if text:
            record["text"] = text
        tweets.append(record)

    if not tweets:
        raise FetchError("No timeline statuses parsed from jina response")

    return {
        "source_tier": "reader_mirror",
        "source_name": "jina",
        "confidence": "low",
        "source_url": source_url,
        "username": _clean_username(username),
        "cursor": "",
        "data": {
            "user": {"screen_name": _clean_username(username)},
            "tweets": tweets,
            "pagination": {
                "nextCursor": "",
                "prevCursor": "",
                "hasMore": False,
                "note": "jina snapshot has no cursor pagination",
            },
        },
        "raw_markdown": markdown,
    }


def _parse_provider_order(raw: str) -> list[str]:
    allowed = {"jina", "twitter-viewer"}
    providers = [part.strip().lower() for part in raw.split(",") if part.strip()]
    normalized: list[str] = []
    for provider in providers:
        if provider in allowed and provider not in normalized:
            normalized.append(provider)
    return normalized


def _summarize_error(err: Exception, max_chars: int = 220) -> str:
    msg = str(err).strip() or err.__class__.__name__
    return msg if len(msg) <= max_chars else msg[: max_chars - 1] + "…"


def _fetch_with_fallback(
    *,
    username: str,
    cursor: str,
    timeout: float,
    providers: list[str],
    viewer_base: str,
    jina_base: str,
) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []
    last_error: Exception | None = None

    for provider in providers:
        if provider == "jina" and cursor:
            attempts.append(
                {
                    "provider": provider,
                    "ok": False,
                    "error": "jina does not support cursor pagination",
                }
            )
            continue

        try:
            if provider == "twitter-viewer":
                url = _build_viewer_url(username, cursor, viewer_base)
                payload, status = _fetch_json(url, timeout)
                normalized = _normalize_from_viewer(
                    payload,
                    username=username,
                    cursor=cursor,
                    source_url=url,
                )
                attempts.append(
                    {
                        "provider": provider,
                        "url": url,
                        "ok": True,
                        "status": status,
                    }
                )
                normalized["attempts"] = attempts
                return normalized

            if provider == "jina":
                url = _build_jina_url(username, jina_base)
                markdown, status = _fetch_text(url, timeout)
                normalized = _normalize_from_jina(markdown, username=username, source_url=url)
                attempts.append(
                    {
                        "provider": provider,
                        "url": url,
                        "ok": True,
                        "status": status,
                    }
                )
                normalized["attempts"] = attempts
                return normalized

            attempts.append(
                {
                    "provider": provider,
                    "ok": False,
                    "error": "unsupported provider",
                }
            )
        except Exception as err:
            last_error = err
            attempt = {"provider": provider, "ok": False, "error": _summarize_error(err)}
            if isinstance(err, FetchError) and err.status is not None:
                attempt["status"] = err.status
            if provider == "twitter-viewer":
                attempt["url"] = _build_viewer_url(username, cursor, viewer_base)
            elif provider == "jina":
                attempt["url"] = _build_jina_url(username, jina_base)
            attempts.append(attempt)

    error_text = _summarize_error(last_error or RuntimeError("unknown fetch failure"))
    raise FetchError(f"all providers failed: {error_text}", attempts=attempts)


def _write_output(data: dict[str, Any], pretty: bool, out_path: str | None) -> None:
    payload = json.dumps(data, ensure_ascii=False, indent=2 if pretty else None)
    if out_path:
        Path(out_path).write_text(payload, encoding="utf-8")
    else:
        print(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch user timeline with provider fallback")
    parser.add_argument("--username", required=True, help="Twitter/X username (without @)")
    parser.add_argument("--cursor", default="", help="Pagination cursor (empty for first page)")
    parser.add_argument("--timeout", type=float, default=15.0, help="Request timeout (seconds)")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    parser.add_argument("--out", default=None, help="Write JSON to a file instead of stdout")
    parser.add_argument(
        "--providers",
        default=DEFAULT_PROVIDERS,
        help="Provider order: jina,twitter-viewer",
    )
    parser.add_argument(
        "--viewer-base",
        default=VIEWER_BASE_URL,
        help="twitter-viewer API base URL",
    )
    parser.add_argument(
        "--jina-base",
        default=JINA_BASE_URL,
        help="r.jina.ai X profile base URL",
    )
    args = parser.parse_args()

    providers = _parse_provider_order(args.providers)
    if not providers:
        print("Error: no valid providers configured", file=sys.stderr)
        return 2

    # Cursor pagination is only available via twitter-viewer.
    if args.cursor and "twitter-viewer" in providers:
        providers = ["twitter-viewer", *[p for p in providers if p != "twitter-viewer"]]

    try:
        data = _fetch_with_fallback(
            username=args.username,
            cursor=args.cursor,
            timeout=args.timeout,
            providers=providers,
            viewer_base=args.viewer_base,
            jina_base=args.jina_base,
        )
    except Exception as exc:
        if isinstance(exc, FetchError) and exc.attempts:
            print(
                json.dumps(
                    {
                        "error": str(exc),
                        "attempts": exc.attempts,
                    },
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
        else:
            print(f"Error: {exc}", file=sys.stderr)
        return 2

    _write_output(data, args.pretty, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
