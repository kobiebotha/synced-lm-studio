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

## Current layout

This repository now includes:

- `apps/web`: the Vite web client that talks to Supabase Auth and PowerSync
- `apps/bridge`: the stateful LM Studio bridge daemon that watches local files and runs on the same machine as LM Studio
- `supabase/`: the hosted database schema and policies
- `powersync/`: PowerSync service and sync configuration

The web client is the part you deploy to Vercel. The bridge is not a Vercel service: it depends on a local LM Studio process, local conversation files, filesystem watchers, and a local SQLite cache.

## Bridge profiles

If you want one bridge pointed at a local dev stack and another pointed at hosted Supabase and PowerSync, do not share a single `apps/bridge/.env.local`.

Use one env file per bridge target instead:

- `apps/bridge/.env.local` for the local stack
- `apps/bridge/.env.cloud` for hosted testing

Each bridge profile should have its own:

- `BRIDGE_MACHINE_KEY`
- `BRIDGE_DB_FILENAME`
- `BRIDGE_SESSION_FILENAME`

Sharing the same LM Studio instance and conversation directory is fine. Sharing the same bridge DB/session files is not.

The bridge loader now supports profile-specific env files:

```bash
pnpm dev:bridge:local
pnpm dev:bridge:cloud
```

Or with an explicit file:

```bash
BRIDGE_ENV_FILE=.env.cloud pnpm dev:bridge
```

To generate a local profile file from the local Supabase CLI output:

```bash
pnpm bootstrap:local-env
```

To generate a second profile file, for example `apps/bridge/.env.staging` and `apps/web/.env.staging`:

```bash
ENV_PROFILE=staging pnpm bootstrap:local-env
```

The bridge can use that file immediately with `BRIDGE_ENV_FILE=.env.staging`. The web app follows Vite's normal env loading, so a non-local web profile should be used with the matching Vite mode.

## Hosted Deployment

### Supabase

The remote schema lives in `supabase/migrations`. After linking the repo to a hosted Supabase project, push the migrations and ensure the `powersync` publication exists. The main migration already creates the publication idempotently.

### Vercel

`vercel.json` is configured to build the Vite app from `apps/web` and publish `apps/web/dist`.

Set these Vercel environment variables for the web client:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_POWERSYNC_URL` once your PowerSync instance is ready
- `VITE_DEV_EMAIL` and `VITE_DEV_PASSWORD` only if you want the sign-in form prefilled

If `VITE_POWERSYNC_URL` is not set yet, the deployed app now shows a setup state instead of crashing at startup.

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
