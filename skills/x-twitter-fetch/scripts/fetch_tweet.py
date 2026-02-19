#!/usr/bin/env python3
"""fetch_tweet_fxtwitter.py

Fetch a single X/Twitter post via FxEmbed (api.fxtwitter.com) and print JSON.

Why:
  - Returns tweet JSON and often includes X Article metadata (title/preview) when present.

Examples:
  python3 scripts/fetch_tweet_fxtwitter.py --username rianSweetDoris --tweet-id 2019833629233324539 --pretty
  python3 scripts/fetch_tweet_fxtwitter.py --url 'https://x.com/RianSweetDoris/status/2019833629233324539' --pretty
  python3 scripts/fetch_tweet_fxtwitter.py --message 'check this https://x.com/.../status/123' --pretty

Notes:
  - Unofficial API; may rate-limit or change.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Dict, List, Optional, Tuple
from urllib import request


DEFAULT_BASE = "https://api.fxtwitter.com"
UA = "Mozilla/5.0 (twitter-viewer-skill; +https://github.com/FxEmbed/FxEmbed)"


STATUS_RE = re.compile(
    r"https?://(?:www\.)?(?:x\.com|twitter\.com)/(?P<user>[A-Za-z0-9_]+)/status/(?P<id>\d+)"
)
# Some links may include /photo/1 or query params; the regex above will match the core.


def parse_from_text(text: str) -> Optional[Tuple[str, str]]:
    m = STATUS_RE.search(text)
    if not m:
        return None
    return m.group("user"), m.group("id")


def _md_escape(text: str) -> str:
    # Minimal escaping to avoid accidental markdown headers/lists from raw text.
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _slugify_filename(name: str, max_len: int = 120) -> str:
    # Produce a filesystem-friendly filename (ASCII-ish) while keeping it readable.
    s = name.strip()
    if not s:
        return "post"
    # Replace common separators with spaces first.
    s = re.sub(r"[\t\n\r]+", " ", s)
    # Drop characters that are problematic on most filesystems.
    s = re.sub(r"[\\/:*?\"<>|]", "", s)
    # Collapse whitespace.
    s = re.sub(r"\s+", " ", s).strip()
    # Convert spaces to dashes.
    s = s.replace(" ", "-")
    # Keep a conservative charset.
    s = re.sub(r"[^A-Za-z0-9._-]", "", s)
    s = re.sub(r"-+", "-", s).strip("-._")
    if not s:
        s = "post"
    if len(s) > max_len:
        s = s[:max_len].rstrip("-._")
    return s


def _render_article_blocks_md(article: dict) -> str:
    content = article.get("content") or {}
    blocks: List[Dict] = content.get("blocks") or []

    out: List[str] = []

    for b in blocks:
        btype = b.get("type")
        text = _md_escape((b.get("text") or "").strip())

        # Skip purely empty/whitespace blocks.
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
            # The API doesn't always include list numbering; render as 1.
            out.append(f"1. {text}")
        elif btype == "atomic":
            # Divider / media placeholders live here; represent as blank line.
            # (Media URLs are available separately under cover_media/media_entities.)
            out.append("---")
        else:
            out.append(text)

    # Normalize spacing: keep paragraphs separated.
    return "\n\n".join([s for s in out if s])


def _looks_english_markdown(md: str, *, min_len: int = 400, ascii_ratio: float = 0.90) -> bool:
    """Heuristic language check.

    Only attempt translation when the source text looks predominantly English.
    (No extra deps; no network calls.)

    - If content is short, translation is still likely desired.
    - Otherwise, treat as English when ASCII character ratio is high.

    Not perfect, but prevents translating already-Chinese content.
    """
    if not md:
        return False
    s = md.strip()
    if len(s) < min_len:
        return True
    total = len(s)
    ascii_count = sum(1 for ch in s if ord(ch) < 128)
    return (ascii_count / max(total, 1)) >= ascii_ratio


def fetch(username: str, tweet_id: str, base: str, timeout: float) -> str:
    url = f"{base.rstrip('/')}/{username}/status/{tweet_id}"
    req = request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
        },
        method="GET",
    )
    with request.urlopen(req, timeout=timeout) as resp:
        data = resp.read().decode("utf-8", errors="replace")
    return data


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()

    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--username", help="Tweet author username (screen_name)")
    # --username requires --tweet-id; validated below.
    src.add_argument("--url", help="Tweet URL (x.com/twitter.com)")
    src.add_argument("--message", help="Free-form text containing a tweet URL")

    p.add_argument("--tweet-id", help="Tweet ID (required when using --username)")
    p.add_argument("--base", default=DEFAULT_BASE, help="API base (default: https://api.fxtwitter.com)")
    p.add_argument("--timeout", type=float, default=30.0)
    p.add_argument("--pretty", action="store_true")
    p.add_argument("--raw", action="store_true", help="Print raw response string")
    p.add_argument(
        "--extract",
        choices=["text", "article", "article_full", "all"],
        help=(
            "Extract key content instead of printing full JSON. "
            "text=best-effort tweet text; article=article title+preview; "
            "article_full=render article blocks as Markdown; all=text + (title+preview)"
        ),
    )
    p.add_argument(
        "--translate-default",
        default="zh",
        help=(
            "Default target language when translation is enabled automatically (default: zh)."
        ),
    )
    p.add_argument("--out", help="Write output to a file instead of stdout")
    p.add_argument(
        "--out-dir",
        help=(
            "Write output to a directory using an auto-generated filename based on the post title. "
            "(Ignored if --out is set.)"
        ),
    )
    p.add_argument(
        "--translate",
        nargs="?",
        const="zh",
        default=None,
        help=(
            "Translate extracted Markdown and write a translated .<lang>.md file. "
            "Use with --extract article_full and --out-dir. "
            "If provided without a value, defaults to zh (Chinese)."
        ),
    )

    args = p.parse_args(argv)

    username: Optional[str] = None
    tweet_id: Optional[str] = None

    if args.username:
        if not args.tweet_id:
            print("ERROR: --tweet-id is required when using --username", file=sys.stderr)
            return 2
        username = args.username
        tweet_id = args.tweet_id
    elif args.url:
        parsed = parse_from_text(args.url)
        if not parsed:
            print("ERROR: Could not parse tweet URL", file=sys.stderr)
            return 2
        username, tweet_id = parsed
    else:
        parsed = parse_from_text(args.message)
        if not parsed:
            print("ERROR: Could not find tweet URL in --message", file=sys.stderr)
            return 2
        username, tweet_id = parsed

    try:
        resp_text = fetch(username, tweet_id, base=args.base, timeout=args.timeout)
    except Exception as e:
        print(f"ERROR: request failed: {e}", file=sys.stderr)
        return 1

    if args.raw:
        print(resp_text)
        return 0

    try:
        obj = json.loads(resp_text)
    except Exception:
        # Not JSON? Print raw.
        print(resp_text)
        return 0

    # Best-effort: if this post is quoting another post that contains an Article,
    # follow the quote so users can pass the "wrapper" tweet URL and still get the article.
    try:
        tweet0 = obj.get("tweet") or {}
        quote0 = tweet0.get("quote") or {}
        # Prefer quote when it has an article (either directly or via embedded tweet.article).
        if quote0 and ((quote0.get("article") is not None) or ((quote0.get("tweet") or {}).get("article") is not None)):
            obj = {"tweet": quote0}
            qid = quote0.get("id") or ""
            qu = quote0.get("url") or ""
            if qid or qu:
                print(f"NOTE: followed_quote={qid or qu}", file=sys.stderr)
    except Exception:
        pass

    if args.extract:
        tweet = obj.get("tweet") or {}
        tweet_text = (tweet.get("text") or "").strip()
        raw_text = ((tweet.get("raw_text") or {}).get("text") or "").strip()
        # Prefer rendered text; fall back to raw_text (sometimes only t.co link).
        best_text = tweet_text or raw_text

        article = tweet.get("article") or {}
        art_title = (article.get("title") or "").strip()
        art_preview = (article.get("preview_text") or "").strip()

        out_lines: List[str] = []
        if args.extract in ("text", "all"):
            if best_text:
                out_lines.append(best_text)

        if args.extract == "article_full":
            md = _render_article_blocks_md(article) if article else ""
            if md:
                out_lines.append(md)
            else:
                # Fall back to title+preview if blocks aren't present.
                if art_title:
                    out_lines.append(f"# {art_title}")
                if art_preview:
                    out_lines.append(art_preview)

        if args.extract in ("article", "all"):
            if art_title:
                out_lines.append(art_title)
            if art_preview:
                out_lines.append(art_preview)

        rendered = "\n\n".join([s for s in out_lines if s]).rstrip() + "\n"

        if args.out:
            out_path = args.out
        elif args.out_dir:
            import os

            os.makedirs(args.out_dir, exist_ok=True)
            # Prefer article title, otherwise fall back to tweet id.
            title_for_name = art_title or f"{username}_{tweet_id}"
            fname = _slugify_filename(title_for_name) + ".md"
            out_path = os.path.join(args.out_dir, fname)
        else:
            out_path = None

        if out_path:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(rendered)

            # Optional translation step (Markdown -> Markdown)
            # Default behavior: if we extracted a full article to a file and it looks English,
            # auto-translate to args.translate_default. Users can override by passing --translate <lang>
            # or disable entirely via --translate-default '' (empty string).
            translated_path = None

            auto_translate_enabled = bool(args.translate_default)
            translate_requested = args.translate is not None
            translate_auto = (
                (not translate_requested)
                and auto_translate_enabled
                and args.extract == "article_full"
                and (out_path is not None)
                and (args.out_dir is not None)
            )

            if translate_requested or translate_auto:
                import os
                import subprocess

                lang = (args.translate or args.translate_default or "zh").strip()
                if not lang:
                    # Explicitly disabled via empty default.
                    print("NOTE: translation disabled (empty lang)", file=sys.stderr)
                    print("OUTPUT_ZH=NONE", file=sys.stderr)
                else:
                    # Only translate when the extracted markdown looks predominantly English.
                    try:
                        if not _looks_english_markdown(rendered):
                            print("NOTE: translation skipped (source does not look English)", file=sys.stderr)
                            print("OUTPUT_ZH=NONE", file=sys.stderr)
                            lang = ""  # sentinel
                    except Exception:
                        # If our heuristic fails for any reason, fall back to attempting translation.
                        pass

                    if lang:
                        base, ext = os.path.splitext(out_path)
                        translated_path = f"{base}.{lang}{ext or '.md'}"

                        # Call helper translator script in the same directory.
                        helper = os.path.join(os.path.dirname(__file__), "openai_translate.py")
                        # Hard timeout to avoid hanging indefinitely on translation.
                        # If translation fails or times out, keep the original Markdown and exit successfully.
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

                        # Run translation in the background so the main fetch/export command returns fast
                        # and doesn't get killed by long-running translation.
                        #
                        # We still *attempt* a quick foreground run if the output is likely to finish fast,
                        # but default is background.
                        try:
                            # Start detached background process (no stdout/stderr to block).
                            with open(os.devnull, "wb") as devnull:
                                subprocess.Popen(cmd, stdout=devnull, stderr=devnull)

                            if lang == "zh":
                                print(f"OUTPUT_ZH_PENDING={translated_path}", file=sys.stderr)
                            else:
                                print(f"OUTPUT_TRANSLATED_PENDING={translated_path}", file=sys.stderr)
                        except Exception as e:
                            msg = str(e)
                            code = "TRANSLATE_FAIL"
                            if "OPENAI_API_KEY" in msg:
                                code = "NO_OPENAI_KEY"
                            print(f"WARN: translation spawn failed ({code}): {e}", file=sys.stderr)
                            print("OUTPUT_ZH=NONE", file=sys.stderr)
                            translated_path = None

            # Helpful when used programmatically.
            print(out_path)
            print(f"OUTPUT_EN={out_path}", file=sys.stderr)
        else:
            sys.stdout.write(rendered)
        return 0

    if args.pretty:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(obj, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        # Common when piping to `head`.
        raise SystemExit(0)
