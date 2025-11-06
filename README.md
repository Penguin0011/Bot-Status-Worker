# Bot Status Worker (Durable Objects)

Cloudflare Worker that tracks Discord bot uptime via heartbeats, powered by Durable Objects (DO) for low-latency, low-write storage. Supports:
- Backward-compatible endpoints (`/heartbeat`, `/api/status`)
- Parallel multi-bot endpoints (`/:bot/heartbeat`, `/:bot/status`)
- Maintenance mode with `status: 2`
- Optional `ping` metric in heartbeat POST body
- CORS for public status reads
- NEW: Synthetic persisted events for:
  - Offline transitions (status `0`) when heartbeats stop for >90s
  - Maintenance start/end (status `2`)

## Endpoints

Public (no auth):
- GET `/api/status` → Default bot status
- GET `/:bot/status` → Status for the specified bot

Authenticated (Bearer AUTH_TOKEN):
- POST `/heartbeat` → Default bot heartbeat
- POST `/:bot/heartbeat` → Named bot heartbeat
- POST `/api/maintenance/enable|disable` → Maintenance for default bot
- POST `/:bot/maintenance/enable|disable` → Maintenance for named bot

Status codes:
- `0` = offline (no heartbeat within 90s)
- `1` = online (heartbeat seen within 90s)
- `2` = maintenance (explicitly enabled)

## New Behavior

### Offline Recording
When the last heartbeat ages beyond 90 seconds, an alarm inserts one synthetic offline event:
```json
{
  "status": 0,
  "time": "2025-01-01T00:00:00.000Z",
  "offline": true,
  "for": "2025-01-01T00:00:00.000Z"
}
```
Only one offline entry per offline transition (per last online heartbeat). Retained for 48h.

### Maintenance Recording
Enabling/disabling maintenance inserts:
```json
{ "status": 2, "time": "...", "maintenance": true, "event": "maintenance_start" }
{ "status": 2, "time": "...", "maintenance": true, "event": "maintenance_end" }
```
During active maintenance `/status` hides the heartbeatList (but events are still stored).

### Uptime Calculation
Counts only `status === 1` heartbeats in last 24h (ignores synthetic offline and maintenance entries). Expected heartbeat cadence: every 60s (max 1440/day).

## Deploy

1. Prereqs
   - Node 18+, Wrangler: `npm i -g wrangler`
   - Cloudflare account: `wrangler login`
2. Secret
```
wrangler secret put AUTH_TOKEN
```
3. Deploy
```
wrangler deploy
```

## Quick Test

Send heartbeat:
```
curl -X POST https://bot-status.<your-subdomain>.workers.dev/heartbeat \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Read status:
```
curl https://bot-status.<your-subdomain>.workers.dev/api/status
```

Maintenance enable:
```
curl -X POST https://bot-status.<your-subdomain>.workers.dev/api/maintenance/enable \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Maintenance disable:
```
curl -X POST https://bot-status.<your-subdomain>.workers.dev/api/maintenance/disable \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Discord Bot Integration (Python)

```python
from discord.ext import tasks, commands
import aiohttp, os

class pushstatus(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.heartbeat_url = "https://bot-status.<your-subdomain>.workers.dev/heartbeat"
        self.auth_token = os.getenv('PUSHTOKEN')
        self.pushstatus.start()

    @tasks.loop(seconds=60)
    async def pushstatus(self):
        ping_ms = round(self.bot.latency * 1000)
        try:
            async with aiohttp.ClientSession() as session:
                headers = {"Authorization": f"Bearer {self.auth_token}", "Content-Type": "application/json"}
                payload = {"ping": ping_ms}
                async with session.post(self.heartbeat_url, headers=headers, json=payload) as r:
                    if r.status != 200:
                        print("Heartbeat failed", r.status)
        except Exception as e:
            print("Heartbeat error:", e)

    @pushstatus.before_loop
    async def before_pushstatus(self):
        await self.bot.wait_until_ready()
```

## Rate Limits & Scaling
- ~100k Worker requests/day (free plan).
- Each bot @ 60s heartbeat ≈ 1,440 req/day.
- Synthetic offline events add minimal overhead (1 per outage).
- Maintenance events add 2 per window.

## Troubleshooting
- 401: token mismatch.
- Offline too soon: ensure loop interval ≤ 60s.
- Uptime low: missed intervals or maintenance not hidden (active maintenance returns empty heartbeatList).
- No offline event: ensure alarms supported in DO (check Wrangler config).

## Security
- Rotate AUTH_TOKEN periodically.
- Only status endpoints are public.

## Future Ideas
- Query param to reveal heartbeats during active maintenance.
- Aggregate downtime & maintenance durations.
- Compression or pagination for heartbeat history.