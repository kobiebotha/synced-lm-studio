# LM Studio Chat Gateway

LM Studio's documented v1 REST API does **not** currently expose a "list chats" endpoint. As of March 20, 2026, the published v1 endpoints are:

- `POST /api/v1/chat`
- `GET /api/v1/models`
- `POST /api/v1/models/load`
- `POST /api/v1/models/unload`
- `POST /api/v1/models/download`
- `GET /api/v1/models/download/status`

This project adds a thin local gateway with two purposes:

- Proxy supported chat requests to LM Studio.
- Expose your local LM Studio conversation files through a simple REST API.

The file-backed chat listing is practical, but it relies on LM Studio's local JSON files in `~/.lmstudio/conversations/`. LM Studio explicitly says those files are JSON and that you should **not** rely on their structure. Treat this as a bridge until you store canonical chat metadata in Supabase.

## Endpoints

### `GET /health`

Returns the configured LM Studio base URL and conversations directory.

### `GET /api/chats`

Lists local LM Studio chat files, newest first.

Example response:

```json
{
  "source": "filesystem",
  "supportedByLmStudioApi": false,
  "count": 2,
  "chats": [
    {
      "id": "4f9c6d50-b0cb-4bd5-8a48-3f4ad17e8b62",
      "title": "Debugging a sync issue",
      "createdAt": "2026-03-20T17:32:11.000Z",
      "updatedAt": "2026-03-20T17:42:03.000Z",
      "model": "qwen/qwen3-14b",
      "messageCount": 8,
      "filePath": "/Users/you/.lmstudio/conversations/4f9c6d50-b0cb-4bd5-8a48-3f4ad17e8b62.json",
      "relativePath": "4f9c6d50-b0cb-4bd5-8a48-3f4ad17e8b62.json",
      "sizeBytes": 21934
    }
  ]
}
```

### `GET /api/chats/:id`

Returns one conversation plus the raw JSON content from disk.

### `POST /api/lmstudio/chat`

Proxies the request body to LM Studio's documented `POST /api/v1/chat`.

Example request:

```json
{
  "model": "qwen/qwen3-14b",
  "input": "Summarize the last three messages."
}
```

## Run

1. Copy `.env.example` to `.env` if you want custom settings.
2. Start the server:

```bash
HOST=127.0.0.1 PORT=8787 LM_STUDIO_BASE_URL=http://127.0.0.1:1234 node src/server.mjs
```

Or:

```bash
npm start
```

## Curl examples

List chats:

```bash
curl http://127.0.0.1:8787/api/chats
```

To expose the gateway on your LAN later, set `HOST=0.0.0.0` and handle your own network security.

Fetch one chat:

```bash
curl http://127.0.0.1:8787/api/chats/<chat-id>
```

Send a message to LM Studio:

```bash
curl http://127.0.0.1:8787/api/lmstudio/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen3-14b",
    "input": "Hello"
  }'
```

Continue a stateful conversation:

```bash
curl http://127.0.0.1:8787/api/lmstudio/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen3-14b",
    "input": "Continue the earlier thread",
    "previous_response_id": "resp_123"
  }'
```

## Recommended next step

For PowerSync and Supabase, do not make `~/.lmstudio/conversations` your source of truth. Use this gateway only to bootstrap existing chats. Once you start creating chats through your own API, persist:

- your own `chat_id`
- LM Studio `response_id`
- title
- timestamps
- message summaries

Then sync that table through Supabase and PowerSync to every client.
