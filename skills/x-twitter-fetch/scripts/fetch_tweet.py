#!/usr/bin/env python3
"""Fetch one X/Twitter post with ordered fallback and normalized output.

Default fetch order:
1) Official embed endpoint (syndication)
2) FxEmbed mirror (api.fxtwitter.com)
3) VX mirror fallback (api.vxtwitter.com)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
from typing import Any, Dict, List, Optional, Tuple
from urllib import request

DEFAULT_FX_BASE = "https://api.fxtwitter.com"
DEFAULT_VX_BASE = "https://api.vxtwitter.com"
DEFAULT_SYNDICATION_BASE = "https://cdn.syndication.twimg.com/tweet-result"
DEFAULT_JINA_STATUS_BASE = "https://r.jina.ai/http://x.com"
DEFAULT_PROVIDER_ORDER = "syndication,fx,vx"
UA = "Mozilla/5.0 (twitter-fetch-skill; +https://github.com/FxEmbed/FxEmbed)"
MARKDOWN_CONTENT_MARKER = "Markdown Content:"
LOGIN_WALL_SNIPPETS = (
    "Don't miss what's happening",
    "Don’t miss what’s happening",
    "People on X are the first to know.",
)
BOILERPLATE_HEADINGS = {
    "New to X?",
    "Trending now",
    "What’s happening",
    "What's happening",
}

STATUS_RE = re.compile(
    r"https?://(?:www\.)?(?:x\.com|twitter\.com)/(?P<user>[A-Za-z0-9_]+)/status/(?P<id>\d+)"
)
URL_RE = re.compile(r"https?://[^\s)>\]\"']+", re.IGNORECASE)
NUMBER_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s?(?:bnb|btc|eth|usdt|usd|%|k|m|b)?\b", re.IGNORECASE)
DATE_RANGE_RE = re.compile(
    r"\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\s*(?:-|–|to)\s*\d{1,2}/\d{1,2}(?:/\d{2,4})?\b",
    re.IGNORECASE,
)
STEP_LINE_RE = re.compile(r"^\s*(?:\d+[\).:-]|[-*•])\s+(.+?)\s*$")
INLINE_STEP_RE = re.compile(r"^\s*\d+\)\s*(.+?)\s*$")


class FetchError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        attempts: Optional[List[dict[str, Any]]] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.attempts = attempts or []


def parse_from_text(text: str) -> Optional[Tuple[str, str]]:
    m = STATUS_RE.search(text)
    if not m:
        return None
    return m.group("user"), m.group("id")


def _md_escape(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _slugify_filename(name: str, max_len: int = 120) -> str:
    s = name.strip()
    if not s:
        return "post"
    s = re.sub(r"[\t\n\r]+", " ", s)
    s = re.sub(r"[\\/:*?\"<>|]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace(" ", "-")
    s = re.sub(r"[^A-Za-z0-9._-]", "", s)
    s = re.sub(r"-+", "-", s).strip("-._")
    if not s:
        s = "post"
    if len(s) > max_len:
        s = s[:max_len].rstrip("-._")
    return s


def _render_article_blocks_md(article: dict[str, Any]) -> str:
    content = article.get("content") if isinstance(article.get("content"), dict) else {}
    blocks = content.get("blocks") if isinstance(content.get("blocks"), list) else []
    out: List[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = str(block.get("type") or "")
        text = _md_escape(str(block.get("text") or "").strip())
        if not text and btype != "atomic":
            continue
        if btype == "header-one":
            out.append(f"# {text}")
        elif btype == "header-two":
            out.append(f"## {text}")
        elif btype == "header-three":
            out.append(f"### {text}")
        elif btype == "unordered-list-item":
            out.append(f"- {text}")
        elif btype == "ordered-list-item":
            out.append(f"1. {text}")
        elif btype == "atomic":
            out.append("---")
        else:
            out.append(text)
    return "\n\n".join([line for line in out if line])


def _looks_english_markdown(md: str, *, min_len: int = 400, ascii_ratio: float = 0.90) -> bool:
    if not md:
        return False
    s = md.strip()
    if len(s) < min_len:
        return True
    total = len(s)
    ascii_count = sum(1 for ch in s if ord(ch) < 128)
    return (ascii_count / max(total, 1)) >= ascii_ratio


def _dedupe_nonempty(values: List[str]) -> List[str]:
    out: List[str] = []
    seen: set[str] = set()
    for value in values:
        trimmed = value.strip()
        if not trimmed:
            continue
        key = trimmed.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(trimmed)
    return out


def _fetch_json(url: str, timeout: float) -> Tuple[int, dict[str, Any], str]:
    req = request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            status = int(getattr(resp, "status", 200))
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise FetchError(f"HTTP {exc.code}: {detail}".strip(), status=int(exc.code)) from exc
    except Exception as exc:
        raise FetchError(str(exc)) from exc

    try:
        payload = json.loads(body)
    except Exception as exc:
        raise FetchError("Response was not valid JSON") from exc
    if not isinstance(payload, dict):
        raise FetchError("JSON root is not an object")
    return status, payload, body


def _fetch_text(url: str, timeout: float, accept: str = "text/plain") -> str:
    req = request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": accept,
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise FetchError(f"HTTP {exc.code}: {detail}".strip(), status=int(exc.code)) from exc
    except Exception as exc:
        raise FetchError(str(exc)) from exc


def _coerce_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _coerce_str(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _canonical_status_url(username: str, tweet_id: str) -> str:
    return f"https://x.com/{username}/status/{tweet_id}"


def _build_jina_status_url(username: str, tweet_id: str, base_url: str) -> str:
    return f"{base_url.rstrip('/')}/{username}/status/{tweet_id}"


def _extract_markdown_body(markdown: str) -> str:
    marker_index = markdown.find(MARKDOWN_CONTENT_MARKER)
    if marker_index >= 0:
        return markdown[marker_index + len(MARKDOWN_CONTENT_MARKER) :].strip()
    return markdown.strip()


def _extract_markdown_section(body: str, heading: str) -> str:
    target = heading.strip().lower()
    capture = False
    collected: List[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            title = stripped[3:].strip()
            if capture:
                break
            if title.lower() == target:
                capture = True
            continue
        if capture:
            collected.append(line)
    return "\n".join(collected).strip()


def _trim_markdown_boilerplate(body: str) -> str:
    collected: List[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            title = stripped[3:].strip()
            if title in BOILERPLATE_HEADINGS and collected:
                break
        collected.append(line)
    return "\n".join(collected).strip()


def _looks_like_login_wall(text: str) -> bool:
    compact = " ".join(text.split())
    if not compact:
        return True
    return len(compact) < 260 and any(snippet in compact for snippet in LOGIN_WALL_SNIPPETS)


def _render_conversation_extract(
    *,
    username: str,
    tweet_id: str,
    args: argparse.Namespace,
) -> Tuple[str, str]:
    source_url = _build_jina_status_url(
        username,
        tweet_id,
        _coerce_str(args.jina_status_base) or DEFAULT_JINA_STATUS_BASE,
    )
    raw_markdown = _fetch_text(source_url, args.timeout)
    body = _extract_markdown_body(raw_markdown)
    post_section = _extract_markdown_section(body, "Post")
    conversation_section = _extract_markdown_section(body, "Conversation")

    rendered_sections: List[str] = []
    if post_section and post_section != conversation_section:
        rendered_sections.append(f"## Post\n\n{post_section}")
    if conversation_section:
        rendered_sections.append(f"## Conversation\n\n{conversation_section}")

    rendered = "\n\n".join(rendered_sections).strip()
    if not rendered:
        rendered = _trim_markdown_boilerplate(body)

    if _looks_like_login_wall(rendered):
        raise FetchError("Readable conversation snapshot is unavailable for this post")

    return rendered.rstrip() + "\n", source_url


def _parse_source_input(args: argparse.Namespace) -> Tuple[str, str]:
    if args.username:
        if not args.tweet_id:
            raise FetchError("--tweet-id is required when using --username")
        username = args.username.strip().lstrip("@")
        tweet_id = args.tweet_id.strip()
        return username, tweet_id
    if args.url:
        parsed = parse_from_text(args.url)
        if not parsed:
            raise FetchError("Could not parse tweet URL")
        return parsed
    parsed = parse_from_text(args.message or "")
    if not parsed:
        raise FetchError("Could not find tweet URL in --message")
    return parsed


def _provider_order(args: argparse.Namespace) -> List[str]:
    raw = [item.strip().lower() for item in (args.providers or "").split(",")]
    allowed = {"syndication", "fx", "vx"}
    return [item for item in raw if item in allowed]


def _provider_urls(
    provider: str,
    *,
    username: str,
    tweet_id: str,
    args: argparse.Namespace,
) -> List[str]:
    if provider == "syndication":
        base = _coerce_str(args.syndication_base) or DEFAULT_SYNDICATION_BASE
        lang = _coerce_str(args.lang) or "en"
        return [f"{base}?id={tweet_id}&lang={lang}"]
    if provider == "fx":
        bases = _dedupe_nonempty(
            [
                _coerce_str(args.base),
                *(_coerce_str(args.fx_bases).split(",")),
                DEFAULT_FX_BASE,
            ]
        )
        return [f"{base.rstrip('/')}/{username}/status/{tweet_id}" for base in bases]
    if provider == "vx":
        bases = _dedupe_nonempty(
            [
                *(_coerce_str(args.vx_bases).split(",")),
                DEFAULT_VX_BASE,
            ]
        )
        return [f"{base.rstrip('/')}/{username}/status/{tweet_id}" for base in bases]
    return []


def _normalize_from_syndication(
    payload: dict[str, Any],
    *,
    source_name: str,
    source_url: str,
    username: str,
    tweet_id: str,
) -> dict[str, Any]:
    if payload.get("errors"):
        raise FetchError("syndication payload contains errors")
    user = _coerce_dict(payload.get("user"))
    author_username = _coerce_str(user.get("screen_name")) or username
    author_name = _coerce_str(user.get("name"))
    text = _coerce_str(payload.get("text"))
    if not text:
        raise FetchError("syndication payload missing text")
    return {
        "source_tier": "official_embed",
        "source_name": source_name,
        "source_url": source_url,
        "confidence": "high",
        "tweet_id": _coerce_str(payload.get("id_str")) or tweet_id,
        "url": _canonical_status_url(author_username, tweet_id),
        "author": {
            "username": author_username,
            "name": author_name,
        },
        "created_at": _coerce_str(payload.get("created_at")),
        "text": text,
        "article": {},
        "raw": payload,
    }


def _normalize_from_fx_like(
    payload: dict[str, Any],
    *,
    source_name: str,
    source_url: str,
    username: str,
    tweet_id: str,
) -> dict[str, Any]:
    tweet = _coerce_dict(payload.get("tweet"))
    if not tweet:
        raise FetchError("mirror payload missing tweet object")

    quote = _coerce_dict(tweet.get("quote"))
    quote_article = _coerce_dict(quote.get("article")) or _coerce_dict(
        _coerce_dict(quote.get("tweet")).get("article")
    )
    selected = quote if quote and quote_article else tweet
    article = _coerce_dict(selected.get("article"))
    author = _coerce_dict(selected.get("author"))
    raw_text = _coerce_dict(selected.get("raw_text"))
    text = _coerce_str(selected.get("text")) or _coerce_str(raw_text.get("text"))
    if not text and not article:
        raise FetchError("mirror payload missing text/article")

    author_username = _coerce_str(author.get("screen_name")) or username
    author_name = _coerce_str(author.get("name"))
    selected_id = _coerce_str(selected.get("id")) or tweet_id
    selected_url = _coerce_str(selected.get("url")) or _canonical_status_url(author_username, selected_id)

    return {
        "source_tier": "mirror_api",
        "source_name": source_name,
        "source_url": source_url,
        "confidence": "medium",
        "tweet_id": selected_id,
        "url": selected_url,
        "author": {
            "username": author_username,
            "name": author_name,
        },
        "created_at": _coerce_str(selected.get("created_at")) or _coerce_str(selected.get("date")),
        "text": text,
        "article": article,
        "raw": payload,
    }


def _normalize_payload(
    provider: str,
    payload: dict[str, Any],
    *,
    source_url: str,
    username: str,
    tweet_id: str,
) -> dict[str, Any]:
    if provider == "syndication":
        return _normalize_from_syndication(
            payload,
            source_name="syndication",
            source_url=source_url,
            username=username,
            tweet_id=tweet_id,
        )
    source_name = "fxtwitter" if provider == "fx" else "vxtwitter"
    return _normalize_from_fx_like(
        payload,
        source_name=source_name,
        source_url=source_url,
        username=username,
        tweet_id=tweet_id,
    )


def _summarize_error(err: Exception, max_chars: int = 220) -> str:
    msg = str(err).strip() or err.__class__.__name__
    if len(msg) <= max_chars:
        return msg
    return msg[: max_chars - 1] + "…"


def fetch_with_fallback(
    *,
    username: str,
    tweet_id: str,
    args: argparse.Namespace,
) -> Tuple[dict[str, Any], str, List[dict[str, Any]]]:
    attempts: List[dict[str, Any]] = []
    providers = _provider_order(args)
    if not providers:
        raise FetchError("No valid providers configured")

    last_error: Optional[Exception] = None

    for provider in providers:
        for url in _provider_urls(provider, username=username, tweet_id=tweet_id, args=args):
            attempt: dict[str, Any] = {
                "provider": provider,
                "url": url,
            }
            try:
                status, payload, raw_text = _fetch_json(url, args.timeout)
                normalized = _normalize_payload(
                    provider,
                    payload,
                    source_url=url,
                    username=username,
                    tweet_id=tweet_id,
                )
                attempt["ok"] = True
                attempt["status"] = status
                attempts.append(attempt)
                normalized["attempts"] = attempts
                return normalized, raw_text, attempts
            except Exception as err:
                last_error = err
                attempt["ok"] = False
                if isinstance(err, FetchError) and err.status is not None:
                    attempt["status"] = err.status
                attempt["error"] = _summarize_error(err)
                attempts.append(attempt)

    last = _summarize_error(last_error or FetchError("unknown fetch failure"))
    raise FetchError(f"all providers failed: {last}", attempts=attempts)


def _extract_hard_fields(normalized: dict[str, Any]) -> dict[str, Any]:
    text = _coerce_str(normalized.get("text"))
    article = _coerce_dict(normalized.get("article"))
    article_title = _coerce_str(article.get("title"))
    article_preview = _coerce_str(article.get("preview_text"))
    combined = "\n".join([part for part in [text, article_title, article_preview] if part]).strip()

    raw_numbers = sorted(set(NUMBER_RE.findall(combined)))
    numbers: List[str] = []
    for token in raw_numbers:
        clean = token.strip()
        digits = re.sub(r"[^0-9]", "", clean)
        has_unit = bool(re.search(r"[a-zA-Z%]", clean))
        has_decimal = "." in clean or "," in clean
        if has_unit or has_decimal or len(digits) >= 3:
            numbers.append(clean)
    date_ranges = sorted(set(DATE_RANGE_RE.findall(combined)))
    links = sorted(set(URL_RE.findall(combined)))

    steps: List[str] = []
    for line in combined.splitlines():
        m = STEP_LINE_RE.match(line)
        if m:
            value = m.group(1).strip()
            if value:
                steps.append(value)
            continue

        # Also support inline "1) ... 2) ... 3) ..." in a single sentence.
        if re.search(r"\b\d+\)\s+", line):
            for part in re.split(r"(?=\b\d+\)\s+)", line):
                part = part.strip()
                if not part:
                    continue
                m_inline = INLINE_STEP_RE.match(part)
                if not m_inline:
                    continue
                value = m_inline.group(1).strip()
                if value:
                    steps.append(value)

    claims: List[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", combined):
        cleaned = sentence.strip()
        if not cleaned:
            continue
        if len(cleaned) < 8:
            continue
        claims.append(cleaned)
        if len(claims) >= 8:
            break

    return {
        "source_tier": normalized.get("source_tier"),
        "source_name": normalized.get("source_name"),
        "confidence": normalized.get("confidence"),
        "tweet_id": normalized.get("tweet_id"),
        "url": normalized.get("url"),
        "fields_extracted": {
            "numbers": numbers,
            "date_ranges": date_ranges,
            "links": links,
            "steps": steps,
            "claims": claims,
        },
    }


def _render_extract_text(
    *,
    extract_mode: str,
    normalized: dict[str, Any],
) -> Tuple[str, str]:
    best_text = _coerce_str(normalized.get("text"))
    article = _coerce_dict(normalized.get("article"))
    art_title = _coerce_str(article.get("title"))
    art_preview = _coerce_str(article.get("preview_text"))

    out_lines: List[str] = []
    if extract_mode in ("text", "all") and best_text:
        out_lines.append(best_text)

    if extract_mode == "article_full":
        md = _render_article_blocks_md(article) if article else ""
        if md:
            out_lines.append(md)
        else:
            if art_title:
                out_lines.append(f"# {art_title}")
            if art_preview:
                out_lines.append(art_preview)

    if extract_mode in ("article", "all"):
        if art_title:
            out_lines.append(art_title)
        if art_preview:
            out_lines.append(art_preview)

    rendered = "\n\n".join([line for line in out_lines if line]).rstrip() + "\n"
    return rendered, art_title


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--username", help="Tweet author username (screen_name)")
    src.add_argument("--url", help="Tweet URL (x.com/twitter.com)")
    src.add_argument("--message", help="Free-form text containing a tweet URL")
    p.add_argument("--tweet-id", help="Tweet ID (required when using --username)")
    p.add_argument("--timeout", type=float, default=30.0)
    p.add_argument("--pretty", action="store_true")
    p.add_argument("--raw", action="store_true", help="Print raw response body of selected source")
    p.add_argument(
        "--providers",
        default=DEFAULT_PROVIDER_ORDER,
        help="Ordered providers: syndication,fx,vx (comma-separated).",
    )
    p.add_argument(
        "--base",
        default=DEFAULT_FX_BASE,
        help="Primary FX base URL (legacy compatibility).",
    )
    p.add_argument(
        "--fx-bases",
        default="",
        help="Extra FX base URLs (comma-separated).",
    )
    p.add_argument(
        "--vx-bases",
        default="",
        help="Extra VX base URLs (comma-separated).",
    )
    p.add_argument(
        "--syndication-base",
        default=DEFAULT_SYNDICATION_BASE,
        help="Syndication base URL.",
    )
    p.add_argument("--lang", default="en", help="Language for syndication endpoint.")
    p.add_argument(
        "--extract",
        choices=["text", "article", "article_full", "all", "conversation"],
        help=(
            "Extract key content. "
            "text=best-effort tweet text; article=title+preview; "
            "article_full=article blocks as Markdown; "
            "conversation=best-effort public thread context via Jina snapshot; "
            "all=text + article title/preview."
        ),
    )
    p.add_argument(
        "--extract-fields",
        action="store_true",
        help="Output only hard fields (numbers/date ranges/links/steps/claims).",
    )
    p.add_argument(
        "--no-raw-payload",
        action="store_true",
        help="Omit raw provider payload from normalized JSON output.",
    )
    p.add_argument(
        "--translate-default",
        default="zh",
        help="Default translation target when auto-translation is enabled (default: zh).",
    )
    p.add_argument("--out", help="Write extracted output to file.")
    p.add_argument("--out-dir", help="Write extracted output to directory with auto filename.")
    p.add_argument(
        "--translate",
        nargs="?",
        const="zh",
        default=None,
        help="Translate extracted Markdown and write a translated .<lang>.md file.",
    )
    p.add_argument(
        "--jina-status-base",
        default=DEFAULT_JINA_STATUS_BASE,
        help="Base URL for best-effort status/conversation snapshots.",
    )
    args = p.parse_args(argv)

    try:
        username, tweet_id = _parse_source_input(args)
    except Exception as err:
        print(f"ERROR: {err}", file=sys.stderr)
        return 2

    if args.extract == "conversation":
        try:
            rendered, source_url = _render_conversation_extract(
                username=username,
                tweet_id=tweet_id,
                args=args,
            )
        except Exception as err:
            print(f"ERROR: request failed: {err}", file=sys.stderr)
            return 1

        if args.out:
            out_path = args.out
        elif args.out_dir:
            os.makedirs(args.out_dir, exist_ok=True)
            fname = _slugify_filename(f"{username}_{tweet_id}_conversation") + ".md"
            out_path = os.path.join(args.out_dir, fname)
        else:
            out_path = None

        if out_path:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(rendered)
            print(out_path)
            print(f"OUTPUT_EN={out_path}", file=sys.stderr)
            print(f"FETCH_SOURCE=jina:{source_url}", file=sys.stderr)
        else:
            sys.stdout.write(rendered)
        return 0

    try:
        normalized, raw_text, attempts = fetch_with_fallback(
            username=username,
            tweet_id=tweet_id,
            args=args,
        )
    except Exception as err:
        print(f"ERROR: request failed: {err}", file=sys.stderr)
        if isinstance(err, FetchError) and err.attempts:
            print(json.dumps({"attempts": err.attempts}, ensure_ascii=False), file=sys.stderr)
        return 1

    if args.no_raw_payload:
        normalized.pop("raw", None)

    if args.raw:
        print(raw_text)
        return 0

    if args.extract_fields:
        payload = _extract_hard_fields(normalized)
        payload["attempts"] = normalized.get("attempts", [])
        if args.pretty:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(json.dumps(payload, ensure_ascii=False))
        return 0

    if args.extract:
        rendered, article_title = _render_extract_text(extract_mode=args.extract, normalized=normalized)

        if args.out:
            out_path = args.out
        elif args.out_dir:
            os.makedirs(args.out_dir, exist_ok=True)
            title_for_name = article_title or f"{username}_{tweet_id}"
            fname = _slugify_filename(title_for_name) + ".md"
            out_path = os.path.join(args.out_dir, fname)
        else:
            out_path = None

        if out_path:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(rendered)

            auto_translate_enabled = bool(args.translate_default)
            translate_requested = args.translate is not None
            translate_auto = (
                (not translate_requested)
                and auto_translate_enabled
                and args.extract == "article_full"
                and (args.out_dir is not None)
            )

            if translate_requested or translate_auto:
                lang = (args.translate or args.translate_default or "zh").strip()
                if not lang:
                    print("NOTE: translation disabled (empty lang)", file=sys.stderr)
                    print("OUTPUT_ZH=NONE", file=sys.stderr)
                else:
                    try:
                        if not _looks_english_markdown(rendered):
                            print("NOTE: translation skipped (source does not look English)", file=sys.stderr)
                            print("OUTPUT_ZH=NONE", file=sys.stderr)
                            lang = ""
                    except Exception:
                        pass

                    if lang:
                        base, ext = os.path.splitext(out_path)
                        translated_path = f"{base}.{lang}{ext or '.md'}"
                        helper = os.path.join(os.path.dirname(__file__), "openai_translate.py")
                        cmd = [
                            sys.executable,
                            helper,
                            "--in",
                            out_path,
                            "--out",
                            translated_path,
                            "--to",
                            lang,
                            "--timeout",
                            "30",
                        ]
                        try:
                            with open(os.devnull, "wb") as devnull:
                                subprocess.Popen(cmd, stdout=devnull, stderr=devnull)
                            if lang == "zh":
                                print(f"OUTPUT_ZH_PENDING={translated_path}", file=sys.stderr)
                            else:
                                print(f"OUTPUT_TRANSLATED_PENDING={translated_path}", file=sys.stderr)
                        except Exception as exc:
                            msg = str(exc)
                            code = "TRANSLATE_FAIL"
                            if "OPENAI_API_KEY" in msg:
                                code = "NO_OPENAI_KEY"
                            print(f"WARN: translation spawn failed ({code}): {exc}", file=sys.stderr)
                            print("OUTPUT_ZH=NONE", file=sys.stderr)

            print(out_path)
            print(f"OUTPUT_EN={out_path}", file=sys.stderr)
            print(
                f"FETCH_SOURCE={normalized.get('source_name')}:{normalized.get('source_url')}",
                file=sys.stderr,
            )
        else:
            sys.stdout.write(rendered)
        return 0

    if args.pretty:
        print(json.dumps(normalized, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(normalized, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(0)
