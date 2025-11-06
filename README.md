# Bot Status Worker

A small Cloudflare Worker + Durable Object service to collect periodic heartbeats from bots/services and expose status, history, and health endpoints for dashboards and monitors.

Features
- Durable Object stores recent heartbeats and events (48h default retention).
- /api/heartbeat (protected) — accept periodic heartbeats (ping in ms).
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
- Method: POST
- Protected: requires Authorization: Bearer <AUTH_TOKEN>
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
  - Simple slot-based metric convenient for quick dashboards.
- uptimeAdjusted: attempts to avoid penalizing uptime when synthetic offline markers were inserted long after their theoretical offline time (e.g., inserted by a fallback on a cold DO or when reads happened long after the transition).
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
  - Bearer token required for posting heartbeats and toggling maintenance.
- Durable Object binding: UPTIME_STORAGE
  - Ensure this DO class is registered in wrangler.toml and bound to the worker.

wrangler.toml example
```toml
name = "bot-status"
main = "worker.js"
compatibility_date = "2024-11-01"

[vars]
# AUTH_TOKEN should be provided as a secret via `wrangler secret put AUTH_TOKEN`

[durable_objects]
bindings = [
  { name = "UPTIME_STORAGE", class_name = "UptimeStorage" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["UptimeStorage"]
```

Security & CORS
- Protected routes:
  - /heartbeat and /maintenance/* require Authorization: Bearer <AUTH_TOKEN>.
  - Keep AUTH_TOKEN secret (wrangler secret put or Cloudflare dashboard).
- Status & History endpoints include Access-Control-Allow-Origin: * by default to simplify web integration. For production, restrict this to your permitted origins.

Logging & diagnostics
- Use `console.log` in the worker for key events (e.g., ALARM fired). Then use:
  - wrangler tail --format pretty
  - to inspect run-time logs and alarm firings.
- If alarms don't appear to run (cold DO edge cases), the read-side fallback inserts a synthetic offline marker when /api/status is next requested.

Testing checklist
- Normal heartbeat:
  - Start your bot's heartbeat loop (POST /heartbeat every minute).
  - /api/status should show status:1 and lastCheck close to now.
  - /api/health returns 200.
- Offline detection:
  - Stop heartbeat loop.
  - Wait HEARTBEAT_TOLERANCE_SECONDS + ~10s.
  - /api/status should show status:0 and contain a synthetic offline entry referring to last known heartbeat time.
  - /api/health should return 503.
- Fallback path:
  - Simulate a cold DO or stop heartbeats and do not wait for alarm to fire. Call /api/status after a long gap — the fallback should insert an offline marker and persist it.
- Maintenance:
  - POST /maintenance/enable (with auth) → /api/status returns status:2 and suppresses offline entries.
  - POST /maintenance/disable to return to normal mode.

Potential enhancements
- Cursor-based pagination for /api/history (after=<ISO> or cursor) for more efficient navigation of large histories.
- Duration-based uptime instead of slot-counting (compute total online time vs offline time).
- Per-bot customization for heartbeat tolerances and cadence.
- Webhook notifications on status transitions (e.g., on offline or recovery).
- Role-based access or per-bot AUTH tokens.

Appendix: common curl snippets

Heartbeat (POST):
curl -X POST \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"ping":82}' \
  https://<domain>/heartbeat

Status:
curl -H 'Cache-Control: no-cache' https://<domain>/api/status

Health:
curl -H 'Cache-Control: no-cache' https://<domain>/api/health

History:
curl -H 'Cache-Control: no-cache' "https://<domain>/api/history?limit=200"

Troubleshooting
- If status remains online even after stopping heartbeats:
  - Confirm you actually stopped sending heartbeats and that no other client is posting.
  - Verify HEARTBEAT_TOLERANCE_SECONDS (default 90s) and wait that amount plus buffer.
- If synthetic "alarm" entries are missing but fallback works:
  - The Durable Object alarm may not have fired due to a cold DO or alarm scheduling delays. The fallback insertion on read ensures the offline marker appears and is persisted.
- If retention needs to be adjusted:
  - Update RETENTION_MS in code and redeploy. Be aware this only affects future pruning.

License
- MIT (or adjust to your preferred license).

Contact & contributions
- Contributions welcome — open issues or PRs with improvements to paging, uptime calculation, or integration examples.
