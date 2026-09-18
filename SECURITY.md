# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting ("Report a vulnerability" under the Security tab of this
repository) so the details stay private until a fix is available.

## What is in scope

- The worker (`worker.js`): routing, bearer-token authentication, Durable Object
  state handling, and the public read endpoints.
- The example client in `cog/`.

## Design notes for reviewers

- `/api/status`, `/api/health` and `/api/history` (and their per-bot forms) are
  intentionally public and unauthenticated; they expose heartbeat timestamps and
  ping values only.
- `/heartbeat` and `/maintenance/*` require `Authorization: Bearer <token>` and
  accept POST only. Tokens are Cloudflare secrets and are compared in constant time.
- Named bots never fall back to the default `AUTH_TOKEN`.
