---
name: x-twitter-fetch
description: Fetch X/Twitter data via twitter-viewer.com (timelines + pagination) and FxEmbed (single tweet / X Article extraction). Supports JSON output and optional Markdown extraction/translation.
---

# X/Twitter Fetch

This skill provides two ways to fetch X/Twitter data:

1. **twitter-viewer.com** for user timelines (paged).
2. **FxEmbed (api.fxtwitter.com)** for a single tweet, often with X Article metadata/blocks.

## Choose an API

- **Need a list / timeline / pagination?** Use `scripts/fetch_user_tweets.py` (twitter-viewer.com).
- **Need one tweet / X Article extraction?** Use `scripts/fetch_tweet.py` (FxEmbed).

## User timeline (twitter-viewer.com)

Script: `scripts/fetch_user_tweets.py`

Fetch the first page:

```bash
python3 scripts/fetch_user_tweets.py --username elonmusk --pretty
```

Pagination:

```bash
python3 scripts/fetch_user_tweets.py --username elonmusk --cursor "<nextCursor>" --pretty
```

Notes:

- `--username` may include `@`; it will be stripped.
- Use `--cursor ""` for the first page.
- `--timeout` (seconds) and `--out` (file path) are supported.

## Single tweet / X Article (FxEmbed)

Script: `scripts/fetch_tweet.py`

The script accepts one of:

- `--username` + `--tweet-id`
- `--url` (x.com / twitter.com)
- `--message` (free-form text containing a tweet URL)

Examples:

```bash
python3 scripts/fetch_tweet.py --username elonmusk --tweet-id <tweetId> --pretty
python3 scripts/fetch_tweet.py --url 'https://x.com/elonmusk/status/<tweetId>' --pretty
python3 scripts/fetch_tweet.py --message 'check this https://x.com/elonmusk/status/<tweetId>' --pretty
```

Extraction modes:

- `--extract text` best-effort tweet text
- `--extract article` article title + preview
- `--extract article_full` render article blocks as Markdown
- `--extract all` text + (title + preview)

Output options:

- `--out <file>` write output to a file
- `--out-dir <dir>` write Markdown to a directory with an auto filename (based on title)
- `--raw` print raw response string

## Optional translation (OpenAI)

When using `--extract article_full` with `--out-dir`, the script can auto-translate
Markdown in the background using `scripts/openai_translate.py`.

- Default: auto-translate to `zh` when the content looks English.
- Override: `--translate <lang>`
- Disable: `--translate-default ''`

Requires `OPENAI_API_KEY` in the environment.

## Output shape

Timeline responses (twitter-viewer.com) include:

- `data.user` profile metadata
- `data.tweets` list of tweets (`id`, `text`, `createdAt`, `author`, ...)
- `data.pagination` (`nextCursor`, `prevCursor`, `hasMore`)

FxEmbed responses include a `tweet` object with text, author, media, and
sometimes `tweet.article` metadata.

## Notes

- These are unofficial, third-party APIs and may change or rate-limit.
