# Bot Status Worker (Durable Objects)

Cloudflare Worker that tracks Discord bot uptime via heartbeats, powered by Durable Objects (DO) for low-latency, low-write storage. Supports:
- Backward-compatible endpoints (`/heartbeat`, `/api/status`)
- Parallel multi-bot endpoints (`/:bot/heartbeat`, `/:bot/status`)
- Maintenance mode with `status: 2`
- Optional `ping` metric in heartbeat POST body
- CORS for public status reads

## Endpoints

Public (no auth):
- GET `/api/status` → Default bot status (backward compatibility)
- GET `/:bot/status` → Status for the specified bot

Authenticated (Bearer AUTH_TOKEN):
- POST `/heartbeat` → Default bot heartbeat (backward compatibility)
- POST `/:bot/heartbeat` → Heartbeat for the specified bot
- POST `/api/maintenance/enable|disable` → Maintenance for default bot
- POST `/:bot/maintenance/enable|disable` → Maintenance for specified bot

Status codes:
- `0` = offline (no heartbeat within 90s)
- `1` = online (heartbeat seen within 90s)
- `2` = maintenance (explicitly enabled)

## Deploy

1) Prereqs
- Node 18+ and Wrangler installed: `npm i -g wrangler`
- Cloudflare account, logged in: `wrangler login`

2) Set your auth secret
```
wrangler secret put AUTH_TOKEN
# paste your shared bearer token
```

3) Deploy
```
wrangler deploy
```

You’ll get a URL like: `https://bot-status.<your-subdomain>.workers.dev`

## Quick test

Default bot (backward compatible):

- Send heartbeat:
```
curl -X POST https://bot-status.<your-subdomain>.workers.dev/heartbeat \
  -H "Authorization: Bearer YOUR_TOKEN"
```

- Read status:
```
curl https://bot-status.<your-subdomain>.workers.dev/api/status
```

Named bot (parallel):

- Send heartbeat:
```
curl -X POST https://bot-status.<your-subdomain>.workers.dev/MyBot/heartbeat \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ping": 42}'
```

- Read status:
```
curl https://bot-status.<your-subdomain>.workers.dev/MyBot/status
```

Maintenance:

- Enable (default bot):
```
curl -X POST https://bot-status.<your-subdomain>.workers.dev/api/maintenance/enable \
  -H "Authorization: Bearer YOUR_TOKEN"
```

- Disable (named bot):
```
curl -X POST https://bot-status.<your-subdomain>.workers.dev/MyBot/maintenance/disable \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Discord bot integration (Python)

- For your existing cog, point `heartbeat_url` to either:
  - Default: `https://bot-status.<your-subdomain>.workers.dev/heartbeat`
  - Named: `https://bot-status.<your-subdomain>.workers.dev/MyBot/heartbeat`
- Send every 60s to match uptime math.

Example:

```python
from discord.ext import tasks, commands
import aiohttp, os

class pushstatus(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.heartbeat_url = "https://bot-status.<your-subdomain>.workers.dev/heartbeat"  # or /MyBot/heartbeat
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

## Rate limits and scaling

- Free plan: ~100k Worker requests/day across this worker.
  - At 60s heartbeat: ~1,440 req/day per bot. ~69 bots ≈ 99k/day.
  - Status reads also count; consider caching on your site or polling less frequently.
- Durable Objects remove KV write/read quotas.
- Each bot gets a separate DO instance and runs independently.

## Troubleshooting

- 401 Unauthorized on heartbeat/maintenance: token mismatch; set `AUTH_TOKEN` via `wrangler secret`.
- status stays 0: increase heartbeat frequency or ensure loop runs; offline threshold is 90s.
- Uptime looks low: ensure 60s interval (math expects 60s).
- Free plan error about DO migration: ensure `new_sqlite_classes` migration exists in wrangler.toml.

## Security

- Treat `AUTH_TOKEN` like a password; rotate periodically.
- Only `/status` is public; heartbeats and maintenance require the token.
