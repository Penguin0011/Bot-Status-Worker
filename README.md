# Bot Status Worker

A small Cloudflare Worker + Durable Object service to collect periodic heartbeats from bots/services and expose status, history, and health endpoints for dashboards and monitors.

Features
- Durable Object stores recent heartbeats and events (48h default retention).
- /heartbeat (protected) — accept periodic heartbeats (ping in ms).
- /api/status — full status, uptime metrics, and recent event list.
- /api/health — minimal, monitor-friendly health endpoint (HTTP 200/503).
- /api/history?limit=… — paginated recent events (newest-first).
- Maintenance mode endpoints to mark planned maintenance windows.
- Synthetic offline detection:
  - Alarm-inserted offline events (timely) via DO alarms.
  - Fallback offline insertion when reads find the DO stale.
- Two uptime metrics:
  - uptime: raw slot-based uptime (counts online heartbeats).
  - uptimeAdjusted: ignores very-late synthetic offline markers for SLA-style reporting.


Quick example requests
- Health (fast):
  - curl -H 'Cache-Control: no-cache' https://<domain>/api/health
- Status (detailed):
  - curl -H 'Cache-Control: no-cache' https://<domain>/api/status
- History (paginated):
  - curl -H 'Cache-Control: no-cache' "https://<domain>/api/history?limit=200"
- Heartbeat (protected, POST):
  - curl -X POST -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" --data '{"ping":82}' https://<domain>/heartbeat

Local development and testing
- Requirements: Node.js 20+ and a Cloudflare account (free tier is enough for deployment; not needed for tests).
- Install dev tooling (wrangler): `npm install`
- Run the unit tests (no Cloudflare account needed): `npm test`
- Verify the worker bundles without deploying: `npm run check`
- Run locally with miniflare: copy `.dev.vars.example` to `.dev.vars` (git-ignored), set `AUTH_TOKEN`, then `npm run dev` and try `curl http://localhost:8787/api/health`.
- Deploy: `npx wrangler deploy`, then set secrets with `npx wrangler secret put AUTH_TOKEN` (and one `<botname>_auth` per named bot).

Routing summary
- Default bot: `/api/status`, `/api/health`, `/api/history`, `/heartbeat` (or `/api/heartbeat`), `/maintenance/enable|disable` (or `/api/maintenance/...`).
- Named bots: `/<botname>/status|health|history|heartbeat|maintenance/...`; the `api` prefix is optional, so `/<botname>/api/status` also works.
- Reserved names: `api`, `heartbeat` and `maintenance` cannot be used as bot names because they select the default bot. Bot names are limited to 64 characters and are case-sensitive for storage (`MyBot` and `mybot` are different bots) but share one secret name after normalization (see below).
- Any other path returns 404 before a Durable Object is touched.

API Reference

1. /api/health
- Purpose: minimal, fast endpoint intended for frequent external checks (UptimeRobot, load-balancer, alerting).
- Method: GET
- Behavior:
  - Returns HTTP 200 when the bot is online (or in maintenance mode).
  - Returns HTTP 503 when offline (no heartbeat within configured tolerance).
- Response JSON:
  - { ok: true|false, status: 0|1|2, lastCheck: "<ISO timestamp>" }
- Notes:
  - Maintenance mode is considered a healthy state (status:2) and returns 200. Adjust behavior if you prefer maintenance to return 503.

2. /api/status
- Purpose: full status for dashboards and debugging.
- Method: GET
- Response JSON includes:
  - status: 0 (offline) | 1 (online) | 2 (maintenance)
  - uptime: slot-based percentage over last 24h (raw)
  - uptimeAdjusted: adjusted percentage that ignores very-late synthetic offline markers
  - lastCheck: ISO timestamp of last received heartbeat (or null)
  - heartbeatList: array of recent events (newest-first). Events include:
    - status: 1 (heartbeat), 0 (synthetic offline), 2 (maintenance)
    - time: ISO timestamp (for synthetic offline the time is the theoretical transition moment)
    - ping: optional ms for heartbeat events
    - offline: true for synthetic offline entries
    - for: ISO timestamp of the online heartbeat that went stale (on synthetic offline entries)
    - insertionMode: "alarm" | "fallback" for synthetic offline entries
    - recordedAt: ISO timestamp when the synthetic entry was inserted

3. /api/history?limit=<n>
- Purpose: paginated retrieval of recent heartbeat/events.
- Method: GET
- Query:
  - limit (optional): number of recent events to return (default 100, max 1000).
- Response JSON:
  - { limit, count, total, items: [...] } (newest first)
- Usage: use this to fetch timeline data without returning the full retention set.

4. /heartbeat
- Purpose: receive heartbeats from the bot(s).
- Method: POST
- Protected: requires Authorization: Bearer <AUTH_TOKEN>
- Body (application/json): optional { "ping": <ms> }
- Behavior:
  - Inserts a status:1 heartbeat with timestamp and ping (if present).
  - Schedules a Durable Object alarm for lastHeartbeat + HEARTBEAT_TOLERANCE_SECONDS to trigger insertion of a timely synthetic offline entry if no new heartbeat arrives.
  - Resets the last-offline tracking so the system can add a new offline marker later if needed.
- Response:
  - 200 on success with JSON { success: true, message: "Heartbeat recorded" }

5. /maintenance/enable and /maintenance/disable
- Purpose: mark planned maintenance windows so offline detection is suppressed.
- Method: POST (GET returns 405)
- Protected: requires Authorization: Bearer <AUTH_TOKEN>
- Also reachable as /api/maintenance/enable|disable and /<botname>/maintenance/enable|disable.
- Behavior:
  - Adds a status:2 maintenance event to history.
  - While maintenance is enabled offline insertion (alarm/fallback) is skipped.

Data model notes
- heartbeats are stored newest-first; entries may be:
  - { status: 1, time: <ISO>, ping: <ms> } — normal heartbeat
  - { status: 0, time: <ISO>, offline: true, for: <ISO>, insertionMode: "alarm" | "fallback", recordedAt: <ISO> } — synthetic offline marker
  - { status: 2, time: <ISO>, maintenance: true, event: "maintenance_start" | "maintenance_end" } — maintenance markers

Metrics and how uptime is computed
- Expected cadence: default 60s (one slot per minute). The system expects 1440 slots per 24h.
- uptime (raw): counts the number of status:1 entries in the past 24h and divides by expected slots, expressed as percentage (clamped to 100%).
- uptimeAdjusted: attempts to avoid penalizing uptime when synthetic offline markers were inserted long after their theoretical offline time (e.g., inserted by a fallback on a cold DO or when reads have been infrequent).
  - Each synthetic offline includes:
    - insertionMode: "alarm" (timely) or "fallback" (read-side fallback).
    - recordedAt: when the synthetic offline entry was created.
    - time: the theoretical offline moment (lastHeartbeat + tolerance).
  - If (recordedAt - time) > LATE_OFFLINE_EXCLUSION_HOURS, that synthetic offline is considered "late" and excluded (treated as if the slot were online) for uptimeAdjusted.
  - Default threshold: 6 hours, configurable via env.

Configuration (constants & env)
- HEARTBEAT_TOLERANCE_SECONDS = 90 (default)
  - Time since last heartbeat to consider the bot offline (seconds).
- HEARTBEAT_INTERVAL_SECONDS = 60 (default)
  - Expected heartbeat cadence (seconds).
- RETENTION_MS = 48 * 60 * 60 * 1000 (default)
  - How long to keep history in the DO (ms).
- LATE_OFFLINE_EXCLUSION_HOURS (env; default 6)
  - Threshold (hours) to decide whether a synthetic offline event is "late" and should be excluded from adjusted uptime.
- AUTH_TOKEN (env/secret)
  - Bearer token required for posting heartbeats and toggling maintenance for the default bot.
- Per-bot secrets: see "Per-bot Cloudflare secrets" below.
- Durable Object binding: UPTIME_STORAGE
  - Ensure this DO class is registered in wrangler.toml and bound to the worker.

Per-bot Cloudflare secrets
- Purpose
  - When hosting multiple bots (multi-tenant), you can protect each bot's protected routes (/heartbeat and /maintenance/*) with a distinct Cloudflare secret per bot instead of a single shared token.
  - The default bot continues to use AUTH_TOKEN (backwards-compatible).
- Naming convention
  - For each non-default bot, set a Cloudflare secret named:
    <normalized-botname>_auth
  - Normalization rules:
    - Convert the bot name to lowercase.
    - Replace any character that is not a lowercase letter, digit, or underscore with an underscore.
    - Append _auth.
  - Examples:
    - Bot name "payment-bot" → secret name payment_bot_auth
    - Bot name "MyBot" → secret name mybot_auth
    - Bot name "My-Bot/Prod" → secret name my_bot_prod_auth
- Path mapping reminders
  - The worker routes multi-bot requests under /<botname>/..., e.g.:
    - POST /payment-bot/heartbeat
    - GET /payment-bot/api/status
  - When posting heartbeats or toggling maintenance for non-default bots, include Authorization: Bearer <secret> where <secret> matches the bot's per-bot Cloudflare secret value.
- How to set secrets with wrangler
  - Default bot (same behavior as before):
    - wrangler secret put AUTH_TOKEN
  - Example: store a secret for a bot named "payment-bot"
    - Normalize to payment_bot_auth, then run:
      wrangler secret put payment_bot_auth
    - When posting heartbeats:
      curl -X POST \
        -H "Authorization: Bearer $PAYMENT_BOT_AUTH" \
        -H "Content-Type: application/json" \
        --data '{"ping":82}' \
        https://<domain>/payment-bot/heartbeat
- Behavior notes
  - Protected routes for non-default bots require the per-bot secret (no fallback to AUTH_TOKEN). This prevents accidental reuse of the default token for other bots.
  - The default bot uses AUTH_TOKEN for backward compatibility; you may continue to post to /heartbeat and /api/status (or to /default/heartbeat if you prefer explicit namespacing).
  - For dashboards and monitors that only read status/health/history, no auth is required (these endpoints are publicly readable by default unless you change the worker to restrict them).
- Security tips
  - Do not commit secret values to git.
  - Use wrangler secret put for each secret or a secure vault and inject as environment secrets at deployment time.
  - Rotate per-bot secrets independently if a single bot is compromised.

Quick example requests
- Health (default bot):
  - curl -H 'Cache-Control: no-cache' https://<domain>/api/health
- Status (default bot):
  - curl -H 'Cache-Control: no-cache' https://<domain>/api/status
- Status (named bot):
  - curl -H 'Cache-Control: no-cache' https://<domain>/payment-bot/api/status
- Heartbeat (named bot, protected):
  - curl -X POST \
      -H "Authorization: Bearer $PAYMENT_BOT_AUTH" \
      -H "Content-Type: application/json" \
      --data '{"ping":82}' \
      https://<domain>/payment-bot/heartbeat

Security notes
- Read endpoints (/api/status, /api/health, /api/history and their per-bot forms) are public and unauthenticated by design; they expose heartbeat timestamps and ping values. Restrict them in worker.js if that is not acceptable for your deployment.
- Bearer tokens are compared in constant time. Tokens are never logged or echoed in responses.
- There is no built-in rate limiting; use Cloudflare rate-limiting rules or WAF if abuse of the public read endpoints is a concern.
- Never commit `.dev.vars` or real tokens. CI runs a gitleaks scan on every push and pull request.
- To report a vulnerability, see SECURITY.md.

License
- MIT. See LICENSE.
