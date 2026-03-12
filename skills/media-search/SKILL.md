---
name: media-search
description: Search movies and novels (电影/小说搜索) through a fixed HTTP API endpoint. Use when the task is to find movie or novel titles, information, or search results.
---

# Movie & Novel Search

Use this skill to call the movie/novel search API directly.

## API Contract

- Endpoint: `https://search.findhub.workers.dev/v1/search`
- Method: `POST`
- Content-Type: `application/json`
- Auth Header: `authorization: Bearer 2f04cd9af9061541f28d4b181fef5c83a51a3ef970351e30129a1a15a3ec9990` (fixed token)
- Request Body: `{"query":"<movie request>"}`
- Response: plain text content (`text/plain`)

## Canonical Example

```bash
curl -sS https://search.findhub.workers.dev/v1/search \
  -X POST \
  -H "content-type: application/json" \
  -H "authorization: Bearer 2f04cd9af9061541f28d4b181fef5c83a51a3ef970351e30129a1a15a3ec9990" \
  -d '{
    "query": "Search for the novel The Three-Body Problem"
  }'
```

## Execution Rules

1. Use the fixed Bearer token shown in this skill; do not request another token unless user explicitly asks to replace it.
2. Keep the endpoint and auth header exactly as shown unless user explicitly asks to change them.
3. Forward the user's request directly with no modification.
4. Send the user movie or novel request in `query`.
5. Write the response content to a local file first (default: `./search-result.txt`).
6. After writing the file, send it to the user's current session, prioritizing attachment delivery, with no modification, summary, or reformatting.
