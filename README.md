# Bot Status Worker

This repository contains a Cloudflare Worker + Durable Object that records periodic heartbeats from your bot(s) and provides status, history and health endpoints for monitoring and a small web integration widget.

Highlights
- Durable Object stores heartbeat history and manages offline detection using alarms.
- Synthetic offline markers are inserted when a heartbeat goes stale (alarm) or as a fallback on the next read if alarms did not run.
- New endpoints: `/api/health`, `/api/history?limit=…` and `/api/status` (returns both raw and adjusted uptime).
- Web integration: small embeddable widget that checks `/api/health`, `/api/status` and `/api/history` and renders a minimal status card.

Quick endpoints summary
- POST /heartbeat (protected)  
  - Records a heartbeat. JSON body optional: { "ping": 123 }  
  - Auth: Bearer token must match AUTH_TOKEN env var.
- GET /api/status  
  - Returns full state for the last 24 hours (heartbeatList), plus:
    - status: 0 offline, 1 online, 2 maintenance
    - uptime: raw uptime percentage (slot-based)
    - uptimeAdjusted: adjusted uptime that ignores "late" synthetic offline markers (see below)
  - CORS enabled.
- GET /api/health  
  - Minimal endpoint useful for external monitors (small response, fast).  
  - Returns HTTP 200 when online and when in maintenance (maintenance is considered an intentional healthy state). Returns 503 when offline. Response body includes { ok, status, lastCheck }.
  - Use this endpoint for availability checks (pings, uptime robot, etc).
- GET /api/history?limit=NN  
  - Returns the most recent heartbeats up to `limit` (default 100, max 1000). Useful for paginating history in the UI.

What changed / new details

1) /api/health (minimal monitor-friendly)
- Behavior:
  - If the Durable Object is in maintenance mode -> returns HTTP 200 and JSON { ok: true, status: 2, mode: 'maintenance', lastCheck }.
  - If last heartbeat is within HEARTBEAT_TOLERANCE_SECONDS (default 90s) -> returns HTTP 200 and JSON { ok: true, status: 1, lastCheck }.
  - If no heartbeat within tolerance -> returns HTTP 503 and JSON { ok: false, status: 0, lastCheck }.
- Use-case: configured as an external service monitor check, alerting on 503.

2) /api/history?limit=…
- Pagination:
  - Query parameter `limit` controls how many items are returned (default 100, capped at 1000).
  - Response: { limit, count, total, items: [...] } where items is an array ordered newest-first.
- Use-case: load the heartbeat history incrementally in dashboards.

3) uptimeAdjusted — secondary uptime metric
- Purpose:
  - Some synthetic offline markers are created as a fallback when the alarm hasn't run or the worker was cold and a read triggered insertion later. Those late-inserted offline events can artificially lower SLA numbers when the system actually had no observed outage.
  - `uptimeAdjusted` ignores synthetic offline markers that were inserted "late" — i.e., the offline marker's recordedAt time is later than the offline moment by more than a configurable threshold — so your SLA calculation doesn't get penalized by late instrumentation.
- How it works:
  - Each synthetic offline entry includes:
    - `insertionMode`: "alarm" (timely alarm insertion) or "fallback" (read-time insertion).
    - `time`: the theoretical offline moment (lastHeartbeat.time + HEARTBEAT_TOLERANCE_SECONDS).
    - `recordedAt`: when the synthetic entry was actually inserted into storage.
  - If (recordedAt - time) > LATE_OFFLINE_EXCLUSION_HOURS (default 6 hours) the offline marker is considered "late" and is ignored for adjusted uptime calculation (the slot counts as online for uptimeAdjusted).
  - Alarm-inserted offline entries are normally near-instant and are counted as offline for both raw and adjusted uptime.

Configuration / environment
- HEARTBEAT_TOLERANCE_SECONDS (hard-coded default in worker: 90s) — threshold to declare offline.
- HEARTBEAT_INTERVAL_SECONDS (default 60s) — expected heartbeat cadence used for slot-based calculations.
- RETENTION_MS (default 48h) — how long to retain heartbeat records.
- LATE_OFFLINE_EXCLUSION_HOURS (default 6) — env var you can set to change the threshold used for adjusted uptime. Example:
  - Set in Wrangler / Cloudflare environment variables:
    - For Wrangler (local deployment), add to `wrangler.toml` [vars] or as a secret:
      ```
      [vars]
      LATE_OFFLINE_EXCLUSION_HOURS = "6"
      ```
    - Or set in Cloudflare dashboard for the Worker binding.

Example curl usages
- Health:
  - curl -i -H 'Cache-Control: no-cache' https://<YOUR_WORKER>/api/health
- Status:
  - curl -H 'Cache-Control: no-cache' https://<YOUR_WORKER>/api/status
- History (limit 50):
  - curl -H 'Cache-Control: no-cache' 'https://<YOUR_WORKER>/api/history?limit=50'
- Heartbeat (protected):
  - curl -X POST -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" -d '{"ping":76}' https://<YOUR_WORKER>/heartbeat

Web integration example
- A minimal embeddable widget is provided in `web/` that:
  - Uses `/api/health` to get a fast decision for monitoring.
  - Fetches `/api/status` to populate a small card showing `status`, `uptime` and `uptimeAdjusted`.
  - Optionally fetches `/api/history?limit=...` to show a short event list.

Embedding
1. Copy `web/index.html` and `web/status-widget.js` to your static site (or reference them directly).
2. Edit the `DATA_URL` in `web/status-widget.js` if you host the worker at a different path.
3. Include `<div id="bot-status-widget"></div>` and `<script src="status-widget.js"></script>` into your page.

Notes and next improvements
- Consider switching slot-based uptime percentages to duration-based uptime (compute time gaps between online heartbeats to better represent outages that are not aligned to one-minute slots).
- Cursor-based pagination for `/api/history` (e.g. after=<ISO>) can be added if you need deep history browsing.
- You can customize the health behavior to return 503 during maintenance if preferred (currently maintenance returns 200 intentionally).

If you'd like, I can:
- Commit these README and web integration files into a branch and open a PR for you.
- Implement cursor pagination (/history?after=ISO) or switch uptime to a duration-based algorithm next.
