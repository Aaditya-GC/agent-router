# Agent Router

A small local proxy that pools multiple [Token Harbor](https://tokenharbor.ai) API keys behind one OpenAI-compatible endpoint. It rotates keys, benches failing ones, tracks token usage and estimated cost, and gives you a dashboard for all of it.

Point opencode (or any OpenAI-compatible client) at `http://localhost:4000/v1` and the router picks a healthy key for every request.

> **Personal, localhost-first tool.** The dashboard can reveal full API keys. Do not expose it to the internet without setting `ROUTER_API_KEY` (and ideally a reverse proxy with TLS).

---

## Features

- **Key pooling & rotation** — `round-robin`, `failover` (stick to the oldest healthy key), or `least-errors`.
- **Automatic cooldowns** — 429/402/5xx put a key on a short, jittered backoff (honoring `retry-after` and "retry in 30 seconds" hints from the upstream body); 401/403 park it for 15 minutes. No key is ever auto-deleted.
- **OpenAI-compatible passthrough** — chat completions, completions, embeddings, responses, and model listing. Streaming (SSE) is passed through byte-for-byte.
- **Usage & cost tracking** — tokens in/out/cached per key and per model, prompt-cache savings, and estimated spend using upstream list prices.
- **Request-size guard** — Token Harbor rejects bodies over ~1.6 MB and misreports it as `context_length_exceeded`. The router drops the oldest base64 images until the request fits (`MAX_REQUEST_BYTES`).
- **Dashboard** — keys, health, free models, per-key daily allowance, logs, and one-click opencode config sync.
- **Bulk key import** — from `HARBOR_KEYS` or `data/keys.txt`.
- **At-rest encryption** — AES-256-GCM when `ROUTER_SECRET` is set.

---

## Requirements

- **Node.js 20+** (uses global `fetch`, `structuredClone`, and top-level `await` in scripts)
- One or more Token Harbor API keys

---

## Quick start

```bash
git clone https://github.com/Aaditya-GC/agent-router.git
cd agent-router
npm install

cp .env.example .env    # Windows: copy .env.example .env
# edit .env and add at least ROUTER_SECRET (and optionally ROUTER_API_KEY)

npm run dev             # development, auto-restarts on changes
# or
npm start               # plain run
```

Open **http://localhost:4000/** and add a key in the dashboard, or bulk-load keys before starting (see below).

Production-style run:

```bash
npm run build
npm run serve
```

---

## Configuration

Copy `.env.example` to `.env`. Everything is optional, but setting `ROUTER_SECRET` is strongly recommended.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port for the router and dashboard. |
| `UPSTREAM_BASE_URL` | `https://tokenharbor.ai/v1` | Upstream OpenAI-compatible base URL. |
| `ROUTER_API_KEY` | *(empty)* | If set, clients must send it as `Authorization: Bearer …` or `x-router-key`. If empty, the router is open (localhost only). |
| `ROUTER_SECRET` | *(empty)* | Encrypts stored upstream keys with AES-256-GCM. **Set this before adding keys** — changing it later makes existing keys undecryptable. Without it, keys are only base64-obfuscated. |
| `HARBOR_KEYS` | *(empty)* | Bulk keys: comma- or newline-separated, `alias=key` or bare key. |
| `STRATEGY` | `round-robin` | Initial rotation strategy: `round-robin`, `failover`, or `least-errors`. Can be changed live in the dashboard. |
| `MAX_REQUEST_BYTES` | `1500000` | Serialized request-size ceiling (~1.5 MB). Oldest images are replaced with a text note until the request fits. |
| `ALLOWANCE_TARGET` | `150` | Target requests per key per day, used for the allowance burn-down panel. |
| `OPENCODE_CONFIG` | `~/.config/opencode/opencode.json` | opencode config file to read/write during sync. |
| `PROVIDER_ID` | `token-harbor-router` | Provider ID used in the opencode config. |
| `FALLBACK_CONTEXT` | `128000` | Context window assumed when the upstream catalog omits one. |
| `MAX_CONTEXT` | `280000` | Cap applied to context windows during sync (keeps text-heavy requests under the byte limit). |

### Adding keys

**Dashboard** — paste an alias and key at http://localhost:4000/ and click **Add key**.

**Bulk file** — create `data/keys.txt` before starting the router:

```text
# comments and blank lines are ignored
harbor-1=th_live_abc123...
harbor-2=th_live_def456...
bare-key-without-alias
```

or use an environment variable:

```env
HARBOR_KEYS=harbor-1=th_live_abc123...,harbor-2=th_live_def456...
```

Placeholders such as `PASTE_*`, `YOUR_KEY`, `CHANGE_ME`, and `xxx` are skipped. Seeding only adds aliases that do not already exist; it never overwrites or updates a key. After the first import you can delete the env var / file — keys live in `data/db.json`.

**API** — see [Admin API](#admin-api).

---

## Using with opencode

The dashboard includes a ready-made provider snippet (**Opencode → Copy snippet**) and a **Sync opencode config** button.

Minimal `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "token-harbor-router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Token Harbor (router)",
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "{file:~/.config/opencode/.router-key}"
      },
      "models": {
        "<harbor-model-id>": {
          "name": "Pooled model",
          "limit": { "context": 128000, "output": 8192 }
        }
      }
    }
  }
}
```

- `baseURL` is the router, not Token Harbor.
- If `ROUTER_API_KEY` is set, its value goes in `options.apiKey` (the file reference above is the most reliable option on Windows). Save the key to `~/.config/opencode/.router-key`.
- If `ROUTER_API_KEY` is empty, use a non-empty placeholder such as `"apiKey": "local"` instead of the file reference.
- Model IDs must match the upstream catalog. Get the real list with `curl http://localhost:4000/v1/models` or use the dashboard snippet.

**Sync model definitions automatically:**

```bash
npm run sync-models
```

With the router running, this fetches the live catalog and rewrites the provider's `models` map in `opencode.json` with accurate context windows, pruning models Token Harbor no longer serves. If your config is JSONC (comments), the sync refuses to write and asks you to edit manually. Restart opencode afterwards.

Environment overrides for the CLI: `ROUTER_BASE_URL` (default `http://localhost:4000`), `ROUTER_API_KEY`, `PROVIDER_ID`, `OPENCODE_CONFIG`, `FALLBACK_CONTEXT`, `MAX_CONTEXT`.

---

## API

### Proxy endpoints

All are OpenAI-compatible and require the router key when `ROUTER_API_KEY` is set.

| Method | Path | Upstream |
| --- | --- | --- |
| `GET` | `/v1/models` | `/models` (cached 60 s) |
| `POST` | `/v1/chat/completions` | `/chat/completions` |
| `POST` | `/v1/completions` | `/completions` |
| `POST` | `/v1/embeddings` | `/embeddings` |
| `POST` | `/v1/responses` | `/responses` |

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

Use `"stream": true` for SSE; the router pipes the stream through and sniffs the final `usage` chunk for stats.

### Health

`GET /health` needs no auth and returns key availability, cooldowns, cache-hit rate, totals, and whether router auth / encryption are enabled.

### Admin API

Requires the router key when `ROUTER_API_KEY` is set.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` / `PUT` | `/api/config` | Read config; set `strategy`. |
| `GET` / `POST` | `/api/keys` | List (includes full keys) / add a key. |
| `PATCH` / `DELETE` | `/api/keys/:id` | Enable/disable, rename, replace key, reset health / delete. |
| `POST` | `/api/keys/:id/test` | Validate a key against the upstream `/models`. |
| `GET` | `/api/stats` | Requests, tokens, cache rate, estimated cost, per-key stats. |
| `GET` | `/api/models` | Catalog with pricing, context, cache support, health. `?refresh=1` bypasses the cache. |
| `POST` | `/api/models/probe` | Send a tiny request to free models (or `ids`) to check liveness. |
| `GET` / `PUT` | `/api/allowance` | Read / set the per-key daily request target. |
| `GET` | `/api/catalog/drift` | Models added or removed since the last sync. |
| `POST` | `/api/sync-models` | Rewrite the configured opencode provider from the live catalog. |
| `GET` | `/api/logs` | Last 120 log lines. |
| `GET` | `/api/opencode-snippet` | Ready-to-paste opencode provider config. |

Example:

```bash
curl -X POST http://localhost:4000/api/keys \
  -H "x-router-key: $ROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"alias":"harbor-1","key":"th_live_..."}'
```

---

## How rotation and cooldowns work

For every request the router builds a list of **usable** keys (`enabled`, not `invalid`, cooldown expired), orders it by the active strategy, then tries them in order until one succeeds.

- **round-robin** — rotates the starting position for each successful request.
- **failover** — always tries the oldest key first; the rest are standbys.
- **least-errors** — sorts by error ratio, then by successes.

On failure:

| Upstream response | Behavior |
| --- | --- |
| `429`, `402`, `500`, `502`, `503`, `504` | Key cooled down using `retry-after`, a body hint like "retry in 30 seconds", or exponential backoff; another key is tried immediately. |
| `401`, `403` | Key parked for 15 minutes (5 for `email_not_verified`); another key is tried. Keys are never auto-marked invalid. |
| Other `4xx` (bad request, unknown model…) | Returned to the client unchanged — retrying another key would fail the same way. |

If every key is cooling down and the soonest is more than 30 seconds away, the router returns `429` (`retry-after` included when the upstream was rate limiting); if a key is about to wake up, it tries that one. When all keys fail, the response is `429` if the last failure was rate limiting or quota-related, otherwise `502`. With no keys configured at all, it returns `503` with a pointer to the dashboard.

---

## Security & data

- Keys are stored in **`data/db.json`**, which is git-ignored.
- With `ROUTER_SECRET` set they are encrypted with AES-256-GCM. Without it they are base64-encoded only — fine for a trusted local machine, not for backups or sharing.
- The dashboard deliberately displays full key values so you can copy/edit them. Treat dashboard access as equivalent to key access.
- Nothing leaves the machine except requests to `UPSTREAM_BASE_URL`.
- Wrong `ROUTER_SECRET` after keys already exist will make them undecryptable. There is no recovery beyond re-adding the keys.

`.env` and `data/` are both git-ignored.

---

## Project structure

```text
src/
  server.ts        Express app: proxy, rotation, cooldowns, admin API, dashboard
  store.ts         data/db.json persistence + key encryption
  opencodeSync.ts  catalog -> opencode model entries
public/
  index.html       single-file dashboard
scripts/
  sync-models.ts   CLI wrapper around opencodeSync
data/              db.json + optional keys.txt (git-ignored, created at runtime)
```

---

## Troubleshooting

**`503 No enabled keys`** — add a key in the dashboard or seed `data/keys.txt` / `HARBOR_KEYS`, then restart.

**`429 All keys cooling down`** — every key hit a rate limit or upstream error. The message includes the soonest alias and ETA. Add more keys, wait, or reset a key's cooldown from the dashboard.

**`context_length_exceeded` for a small prompt** — this is usually Harbor's ~1.6 MB body limit, not the model's context. Lower `MAX_REQUEST_BYTES`, or let the router drop older images (it already does by default).

**Keys show "undecryptable"** — `ROUTER_SECRET` changed or is missing. Restore the original secret or replace the keys.

**`npm run sync-models` says the config is not plain JSON** — opencode configs with comments (JSONC) are not rewritten. Remove comments, or edit the provider manually.

**opencode returns 401** — set the same value as `ROUTER_API_KEY` in the provider's `apiKey`, restart opencode, and make sure the router is running.

**Requests time out** — the router aborts upstream calls after 90 seconds.
