#!/usr/bin/env python3
"""openai_translate.py

Translate a Markdown-ish text file via OpenAI API.

Design goals:
- Keep Markdown structure reasonably intact (do not translate code blocks or bare URLs).
- Translate line-by-line (fast, resilient, avoids huge-context requests).

Env:
  OPENAI_API_KEY: required
  OPENAI_BASE_URL: optional (defaults to https://api.openai.com/v1)
  OPENAI_MODEL: optional (defaults to gpt-4.1-mini)

Usage:
  python3 openai_translate.py --in input.md --out input.zh.md --to zh --timeout 30

Notes:
- This is intentionally conservative: it skips translation inside fenced code blocks.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from urllib import request
from urllib import error as urlerror


def _env(name: str, default: str | None = None) -> str | None:
    v = os.getenv(name)
    return v if v is not None and v != "" else default


def _call_openai(base_url: str, api_key: str, model: str, prompt: str, timeout: float) -> str:
    url = base_url.rstrip("/") + "/responses"
    body = {
        "model": model,
        "input": prompt,
        # Keep it deterministic for translation.
        "temperature": 0,
    }
    data = json.dumps(body).encode("utf-8")
    req = request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urlerror.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        raise RuntimeError(f"HTTP {e.code}: {e.reason}\n{err_body}".rstrip())


def _extract_output_text(resp_text: str) -> str:
    try:
        obj = json.loads(resp_text)
    except Exception:
        return resp_text

    # Responses API: prefer output_text convenience field
    if isinstance(obj, dict) and isinstance(obj.get("output_text"), str):
        return obj["output_text"]

    # Fallback: walk output[].content[].text
    if isinstance(obj, dict) and isinstance(obj.get("output"), list):
        chunks: list[str] = []
        for item in obj["output"]:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for c in content:
                if isinstance(c, dict) and isinstance(c.get("text"), str):
                    chunks.append(c["text"])
        if chunks:
            return "".join(chunks)

    return resp_text


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="in_path", required=True)
    p.add_argument("--out", dest="out_path", required=True)
    p.add_argument("--to", default="zh")
    p.add_argument("--timeout", type=float, default=30.0)
    args = p.parse_args(argv)

    api_key = _env("OPENAI_API_KEY")
    if not api_key:
        print("ERROR: OPENAI_API_KEY env var not set", file=sys.stderr)
        return 2

    base_url = _env("OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = _env("OPENAI_MODEL", "gpt-4.1-mini")

    try:
        src = open(args.in_path, "r", encoding="utf-8").read()
    except FileNotFoundError:
        print(f"ERROR: input file not found: {args.in_path}", file=sys.stderr)
        return 2

    def translate_chunk(chunk: str) -> str:
        prompt = (
            f"Translate the following text into {args.to}. "
            "Do not add commentary. Return ONLY the translated text.\n\n"
            "---BEGIN---\n"
            f"{chunk}\n"
            "---END---"
        )
        raw = _call_openai(base_url, api_key, model, prompt, timeout=args.timeout)
        return _extract_output_text(raw).strip()

    lines = src.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out_lines: list[str] = []

    in_code = False

    def flush_text_buffer(buf: list[str]):
        if not buf:
            return
        chunk = "\n".join(buf).strip("\n")
        if not chunk:
            buf.clear()
            return
        translated = translate_chunk(chunk)
        # Preserve line structure roughly by splitting back on newlines.
        out_lines.extend(translated.split("\n"))
        buf.clear()

    def write_partial():
        # Best-effort partial write so background runs produce output progressively.
        try:
            tmp = args.out_path + ".partial"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(out_lines).rstrip() + "\n")
            os.replace(tmp, args.out_path)
        except Exception:
            pass

    text_buf: list[str] = []
    max_chars = 1800  # keep requests small-ish for latency/reliability

    for line in lines:
        stripped = line.strip()

        # Toggle fenced code blocks: keep everything inside unchanged.
        if stripped.startswith("```"):
            flush_text_buffer(text_buf)
            in_code = not in_code
            out_lines.append(line)
            continue
        if in_code:
            out_lines.append(line)
            continue

        # Preserve blank lines, hr, and bare URLs.
        if stripped == "" or stripped == "---" or stripped.startswith("http://") or stripped.startswith("https://"):
            flush_text_buffer(text_buf)
            out_lines.append(line)
            continue

        # Headings/list items: translate but keep prefix; flush buffer before/after.
        if stripped.startswith("#") and " " in line:
            flush_text_buffer(text_buf)
            prefix, rest = line.split(" ", 1)
            if prefix.lstrip("#") == "":
                out_lines.append(prefix + " " + translate_chunk(rest))
                write_partial()
                continue

        if stripped.startswith("- "):
            flush_text_buffer(text_buf)
            idx = line.find("- ")
            prefix = line[: idx + 2]
            rest = line[idx + 2 :]
            out_lines.append(prefix + translate_chunk(rest))
            write_partial()
            continue

        m = re.match(r"^(\s*)(\d+\.\s+)(.*)$", line)
        if m:
            flush_text_buffer(text_buf)
            ws, prefix, rest = m.groups()
            out_lines.append(ws + prefix + translate_chunk(rest))
            write_partial()
            continue

        # Default: buffer normal lines into chunks.
        tentative = ("\n".join(text_buf + [line]))
        if len(tentative) > max_chars:
            flush_text_buffer(text_buf)
            write_partial()
        text_buf.append(line)

    flush_text_buffer(text_buf)
    write_partial()

    out = "\n".join(out_lines).rstrip() + "\n"
    with open(args.out_path, "w", encoding="utf-8") as f:
        f.write(out)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(0)
