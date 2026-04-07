---
name: x-twitter-fetch
description: Fetch X/Twitter posts, thread context, X Articles, and user timelines via public no-key endpoints. Supports direct X/Twitter status URLs, best-effort conversation extraction, JSON output, and optional Markdown translation.
---

# X/Twitter Fetch

This skill provides public no-key ways to fetch X/Twitter data:

1. **r.jina.ai** as primary timeline snapshot source (best-effort readable timeline).
2. **twitter-viewer.com** for cursor-based timeline pagination.
3. **FxEmbed (api.fxtwitter.com)** for a single tweet, often with X Article metadata/blocks.
4. **r.jina.ai status snapshots** for best-effort public thread / conversation context.

## Choose an API

- **Need a list / timeline / pagination?** Use `scripts/fetch_user_tweets.py` (default provider order: `jina,twitter-viewer`).
- **Need one tweet / X Article extraction?** Use `scripts/fetch_tweet.py`.
- **Need best-effort thread context for a direct post URL?** Use `scripts/fetch_tweet.py --extract conversation`.

### Mandatory routing rules

- If input contains a direct post URL (`x.com/.../status/<id>` or `twitter.com/.../status/<id>`):
  - Always use `scripts/fetch_tweet.py` first.
  - Do not start with `scripts/fetch_user_tweets.py`.
- Only use `scripts/fetch_user_tweets.py` when the user asks for a timeline/list/pagination.
- Before asking the user to paste text manually, run at least one single-post retry with `scripts/fetch_tweet.py` using `--url` or `--message`.

### Ordered fallback inside `fetch_tweet.py`

For single post fetch, the script now retries sources in this order (unless overridden):

1. `syndication` (official embed endpoint)
2. `fx` (`api.fxtwitter.com`)
3. `vx` (`api.vxtwitter.com`)

Each attempt is recorded in the output `attempts` array.

### Best-effort conversation mode

For a direct post URL, `fetch_tweet.py` also supports a public thread-context mode:

```bash
python3 scripts/fetch_tweet.py --url 'https://x.com/<user>/status/<tweetId>' --extract conversation
```

Notes:

- This uses `r.jina.ai/http://x.com/.../status/...` and extracts the readable `Post` / `Conversation` sections when available.
- It is best-effort only. Some public status pages degrade to login-wall content or incomplete snapshots.
- Use this when the user wants surrounding thread context, not just the single post body.

## User timeline

Script: `scripts/fetch_user_tweets.py`

Provider behavior:

- Default: try `jina` first, fallback to `twitter-viewer`.
- If `--cursor` is provided: script will prioritize `twitter-viewer` (because `jina` has no cursor pagination).

Fetch the first page:

```bash
python3 scripts/fetch_user_tweets.py --username elonmusk --pretty
```

Pagination:

```bash
python3 scripts/fetch_user_tweets.py --username elonmusk --cursor "<nextCursor>" --pretty
```

Force provider order:

```bash
python3 scripts/fetch_user_tweets.py --username elonmusk --providers "jina,twitter-viewer" --pretty
python3 scripts/fetch_user_tweets.py --username elonmusk --providers "twitter-viewer" --cursor "<nextCursor>" --pretty
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

Recommended first attempt for direct links:

```bash
python3 scripts/fetch_tweet.py --url 'https://x.com/<user>/status/<tweetId>' --extract all --pretty
```

If the user needs thread context, try:

```bash
python3 scripts/fetch_tweet.py --url 'https://x.com/<user>/status/<tweetId>' --extract conversation
```

If the first attempt fails, retry once with:

```bash
python3 scripts/fetch_tweet.py --message 'https://x.com/<user>/status/<tweetId>' --extract all --pretty
```

Hard-fields only mode (numbers / date ranges / links / steps / claims):

```bash
python3 scripts/fetch_tweet.py --url 'https://x.com/<user>/status/<tweetId>' --extract-fields --pretty
```

Extraction modes:

- `--extract text` best-effort tweet text
- `--extract article` article title + preview
- `--extract article_full` render article blocks as Markdown
- `--extract conversation` best-effort public post + conversation snapshot
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
