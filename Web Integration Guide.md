# Web Integration Notes — Bot Status Worker

This document explains how to integrate a web UI, dashboard, or external monitor with the Bot Status Worker.

Endpoints overview
- GET /api/health
  - Simple, low-latency health check. Returns 200 when healthy/maintenance; 503 when offline.
  - Use for frequent polling (30–60s checks).
- GET /api/status
  - Full status payload for dashboards, includes uptime, uptimeAdjusted, lastCheck, and recent heartbeatList.
  - Use for detailed pages or occasional refreshes.
- GET /api/history?limit=<n>
  - Returns recent events (newest-first) up to `limit`. Default 100, max 1000.
  - Use this for timeline views or exporting recent logs.
- POST /heartbeat
  - Protected endpoint used by the bot to post heartbeats. Must include Authorization header.
- POST /maintenance/enable and POST /maintenance/disable
  - Protected endpoints to declare planned maintenance windows.

Design recommendations for a web dashboard

1. Polling strategy
- Use /api/health for frequent monitoring (every 30–60s). This is small and returns an appropriate HTTP status code for most monitors.
- Use /api/status for UI refreshes or when the user opens a dashboard (every 30–120s).
- Avoid aggressive polling of /api/status in high-traffic pages—fetch it in the background only when needed.

2. Using uptimeAdjusted vs uptime
- uptime (raw):
  - Slot-based: counts received online heartbeat slots over the last 24 hours (default cadence 60s).
  - Use this for a strict "what did the store see" view.
- uptimeAdjusted:
  - Ignores synthetic offline markers that were inserted long after their theoretical offline time.
  - Useful when your Durable Object might be cold or status reads are infrequent: prevents a single delayed read from retroactively degrading the SLA.
- Dashboard suggestion:
  - Show uptimeAdjusted as primary SLA metric.
  - Show uptime (raw) as secondary or in an "advanced metrics" section with explanation.

3. Handling synthetic offline markers
- Two kinds of synthetic offline entries:
  - insertionMode: "alarm" — inserted by the DO alarm at the expected offline moment (timely).
  - insertionMode: "fallback" — inserted on a read when the DO previously didn't insert an alarm record (late insert).
- Both are persisted in heartbeatList and should be shown in timelines, but can be annotated visually:
  - "Observed offline" for alarm entries.
  - "Inferred offline (fallback)" for fallback entries, possibly with a "recordedAt" timestamp to indicate the insertion was delayed.
- Example synthetic offline entry:
  {
    status: 0,
    time: "2025-11-06T21:26:16.460Z",         // theoretical offline moment
    offline: true,
    for: "2025-11-06T21:24:46.459Z",          // last heartbeat that went stale
    insertionMode: "fallback",
    recordedAt: "2025-11-06T22:09:00.000Z"    // when the marker was inserted
  }

4. Pagination & timeline UI
- Use /api/history?limit=100 (or larger) for initial load.
- For long time ranges, implement cursor-based paging on the client (e.g., fetch newest N, then request older items with offset or a timestamp filter).
- If you need server-side cursor support, consider adding ?after=<ISO> or ?before=<ISO> to the worker.

5. Interpreting status transitions
- The worker stores heartbeats newest-first. To detect transitions:
  - Look for a status:0 synthetic offline entry followed later by a status:1 heartbeat — indicates offline -> recovery.
  - Combine heartbeat timestamps with ping values for richer diagnostics.
- If an offline event's insertionMode is "fallback" and recordedAt is long after the offline time, display a tooltip: "This offline marker was inferred when the dashboard polled; it may have been reco[...]"

6. Example UI flow (timeline)
- Fetch /api/history?limit=200 and show newest-first.
- For each item:
  - status:1 — show green dot with ping value.
  - status:0 — show red dot and "offline" label, show for+time and insertionMode details.
  - status:2 — show maintenance marker (neutral color) with event text.
- Implement a filtering option: show/hide fallback entries or highlight them.

7. Monitor integration (external monitoring)
- Use /api/health for simple monitors:
  - HTTP 200 → healthy (or maintenance).
  - HTTP 503 → unhealthy/offline.
- Include Cache-Control: no-cache in check requests to avoid cached responses:
  - curl -H 'Cache-Control: no-cache' https://<domain>/api/health
- Polling cadence:
  - 30–60s for UptimeRobot-type services.
  - If you expect bursts of short outages, set your monitor to a frequency that balances false positives vs detection speed.

8. Handling maintenance windows
- When you plan maintenance, call POST /maintenance/enable (with auth).
- The worker will:
  - Insert a maintenance event (status:2) and suppress offline insertions during maintenance.
- After maintenance, call POST /maintenance/disable to resume normal detection.

9. Error handling & edge cases
- If /api/status shows status:1 but /api/health returns 503:
  - Unlikely (health derives from last heartbeat). If observed, confirm the request used 'no-cache' and the same botName path.
- If you see many fallback offline entries:
  - The DO alarms may not be firing reliably (cold DO or scheduling delays). The fallback is intentional and preserves an audit trail; consider tuning LATE_OFFLINE_EXCLUSION_HOURS if you want to ignor[...] 

10. Example JavaScript snippets

Fetch health (50s polling recommended)
```js
async function fetchHealth(domain) {
  const res = await fetch(`${domain}/api/health`, { headers: { 'Cache-Control': 'no-cache' } });
  if (res.status === 200) {
    const json = await res.json();
    // ok or maintenance
    return { healthy: json.ok, status: json.status, lastCheck: json.lastCheck };
  } else {
    // 503 or other -> unhealthy
    return { healthy: false, status: 0 };
  }
}
```

Fetch status for dashboard
```js
async function fetchStatus(domain) {
  const res = await fetch(`${domain}/api/status`, { headers: { 'Cache-Control': 'no-cache' } });
  const data = await res.json();
  // data.status, data.uptime, data.uptimeAdjusted, data.heartbeatList
  return data;
}
```

Fetch history (paginated)
```js
async function fetchHistory(domain, limit = 200) {
  const res = await fetch(`${domain}/api/history?limit=${limit}`, { headers: { 'Cache-Control': 'no-cache' } });
  return await res.json(); // { limit, count, total, items }
}
```

11. Visual / UX tips
- Show uptimeAdjusted prominently and explain its behavior in a tooltip (why certain offline markers are ignored).
- Color-code events:
  - Green = heartbeat (online)
  - Red = synthetic offline (alarm)
  - Orange/Dashed = synthetic offline (fallback)
  - Gray = maintenance
- Provide a small legend clarifying insertionMode and recordedAt semantics.

12. Further enhancements to consider
- Cursor-based history endpoints (`after`, `before`) for efficient scrolling.
- Duration-based uptime (compute total offline time vs online time) for more precise SLA reporting.
- Per-bot configuration: allow each bot to set a custom tolerance or cadence.
- Webhook notifications on status transitions (e.g., on offline or recovery).
- Role-based access or per-bot AUTH tokens.

Appendix — Synthetic offline behavior summary
- Alarm path: DO schedules an alarm for lastHeartbeat + HEARTBEAT_TOLERANCE_SECONDS on each heartbeat. If it fires and the heartbeat is stale, DO inserts a synthetic offline event with insertionMode: [...] 
- Fallback path: If the alarm didn't fire (e.g., cold DO), the next /api/status read detects the stale lastHeartbeat and inserts a synthetic offline event with insertionMode: "fallback" and recordedAt[...] 
- Use insertionMode and recordedAt to annotate, filter, or exclude late/inferred offline markers in dashboard analytics.