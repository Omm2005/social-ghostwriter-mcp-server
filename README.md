# LinkedIn MCP Server on Cloudflare Workers (OAuth)

This is a TypeScript Cloudflare Worker MCP server equivalent of the Python `linkedin-mcp` server, with OAuth-based auth and matching LinkedIn posting tools.

## Implemented MCP Tools

- `linkedin_get_profile`
- `linkedin_create_post` (single unified post tool: text, mentions, image upload, or video upload)

`linkedin_create_post` media inputs:
- text-only post: omit `media`
- media post(s): `media: [{ "type": "IMAGE|VIDEO", "url": "...", "title": "...", "description": "..." }]`
- mixed image+video in one request is allowed (creates one image post and one video post)

Additional `linkedin_create_post` parameters:
- `author_urn` (optional): post as `urn:li:person:<id>` or `urn:li:organization:<id>`
- `lifecycle_state` (optional): `PUBLISHED` or `DRAFT` (default `PUBLISHED`)

Rules:
- If `media` contains both IMAGE and VIDEO items, the tool creates multiple posts and returns all post IDs.

Mention object shape:

```json
{
  "entity_urn": "urn:li:person:...",
  "start": 0,
  "length": 8,
  "entity_type": "member"
}
```

`entity_type` can be `member` or `company` (`urn:li:organization:...`).

## Posting Guide

See [POSTING_GUIDE.md](./POSTING_GUIDE.md) for mention index math (`start`/`length`), payload examples, and troubleshooting.

## Routes

- MCP API: `/mcp`
- OAuth authorize: `/authorize`
- OAuth token: `/token`
- OAuth client registration: `/register`
- LinkedIn callback: `/callback`

## Setup

1. Install dependencies:

```bash
cd linkedin-mcp-cloudflare
npm install
```

2. Create KV namespace for OAuth state:

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the returned ID into `wrangler.jsonc` under `kv_namespaces[0].id`.

3. Set Worker secrets:

```bash
npx wrangler secret put LINKEDIN_CLIENT_ID
npx wrangler secret put LINKEDIN_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

Optional allowlist for MCP OAuth clients:

```bash
npx wrangler secret put ALLOWED_MCP_CLIENT_IDS
```

4. Configure your LinkedIn app redirect URI:

- Local: `http://localhost:8788/callback`
- Prod: `https://<worker-name>.<subdomain>.workers.dev/callback`

5. Run locally:

```bash
npm run dev
```

6. Deploy:

```bash
npm run deploy
```

## Optional env vars

- `LINKEDIN_VERSION` (default `202506`)
- `RESTLI_PROTOCOL_VERSION` (default `2.0.0`)
- `ENABLE_DEBUG_TOOLS` (`true` enables `linkedin_get_auth_diagnostics`)

## Notes

- LinkedIn may not always return a refresh token for all app configurations/scopes.
- When no refresh token is available and access token expires, users must re-authenticate.
