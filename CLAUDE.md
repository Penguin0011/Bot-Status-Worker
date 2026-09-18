# CLAUDE.md - Bot Status Worker

## Project Overview

**Bot Status Worker** is a Cloudflare Workers + Durable Objects service that monitors bot/service health through periodic heartbeats. It provides real-time status, historical uptime metrics, and health endpoints for dashboards and external monitors.

### Key Features
- **Durable Object storage** for persistent heartbeat history (48h retention)
- **Multi-bot support** via URL-based routing (`/<botname>/...`)
- **Synthetic offline detection** using both DO alarms (timely) and fallback insertion (when DO is cold)
- **Dual uptime metrics**: raw slot-based uptime + adjusted uptime (excludes late synthetic markers)
- **Maintenance mode** to suppress offline detection during planned downtime
- **Per-bot authentication** using Cloudflare secrets

---

## Architecture

### Components

1. **Worker (`worker.js`)**
   - Entry point for all HTTP requests
   - Handles routing, authentication, and CORS
   - Supports both default bot (`/api/status`) and multi-bot paths (`/<botname>/api/status`)
   - Forwards requests to appropriate Durable Object instances

2. **Durable Object (`UptimeStorage` class in `worker.js`)**
   - Class: `UptimeStorage`, exported from the same module as the worker
   - Manages state for a single bot: heartbeats, maintenance status, offline tracking
   - Implements alarm-based synthetic offline insertion
   - Provides all API endpoints: `/heartbeat`, `/status`, `/health`, `/history`, `/maintenance/*`

3. **Configuration (`wrangler.toml`)**
   - Defines worker name, compatibility date
   - Binds Durable Object class `UptimeStorage` to `UPTIME_STORAGE`
   - Configures observability and logging

4. **Client Example (`cog/pushstatus.py`)**
   - Discord.py cog demonstrating heartbeat posting
   - Posts ping metrics every 60s with bearer token auth
   - URL and token come from `PUSHSTATUS_URL` / `PUSHTOKEN` environment variables

5. **Tests (`test/worker.test.mjs`)**
   - `node --test` unit tests with an in-memory Durable Object state double
   - Cover routing, auth, input hardening, history pagination, offline detection, cold start

---

## File Structure

```
Bot-Status-Worker/
├── worker.js                    # Worker entry point (routing, auth) + UptimeStorage Durable Object
├── wrangler.toml                # Cloudflare Workers config
├── package.json                 # npm scripts (test, check, dev, deploy) + wrangler dev dependency
├── .dev.vars.example            # Template for local secrets (copy to .dev.vars, git-ignored)
├── test/
│   └── worker.test.mjs         # Unit tests (node --test)
├── .github/workflows/ci.yml     # CI: tests, wrangler dry-run, gitleaks secret scan
├── README.md                    # User-facing documentation
├── SECURITY.md                  # Vulnerability reporting
├── LICENSE                      # MIT
├── Web Integration Guide.md     # Dashboard/UI integration guide
├── cog/
│   └── pushstatus.py           # Example Discord bot heartbeat client
└── CLAUDE.md                    # This file (AI assistant guide)
```

### File Descriptions

- **`worker.js`**
  - Exports default object with `fetch()` handler, plus `UptimeStorage`, `resolveRoute`, `timingSafeEqual`
  - `resolveRoute()`: maps a path to `{ botName, actionPath }`; rejects unknown actions and over-long bot names before any DO is touched
  - Auth: protects `/heartbeat` and `/maintenance/*` with bearer tokens (POST only, constant-time compare)
  - Per-bot secrets: `<normalized_botname>_auth` for non-default bots; default bot uses `AUTH_TOKEN`
  - `UptimeStorage`: constructor kicks off `initializeState()`; `fetch()`/`alarm()` await it before handling
  - Key methods: `handleHeartbeat`, `handleStatus`, `handleHealth`, `handleHistory`, `handleMaintenance`
  - Uptime calculations: `calculateUptime()` (raw), `calculateUptimeAdjusted()` (SLA-friendly)
  - Note: the former `uptime-storage.mjs` was an unused, older copy of the DO class and has been removed

- **`wrangler.toml`**
  - Worker name: `bot-status`
  - Main entry: `worker.js`
  - Durable Object binding: `UPTIME_STORAGE` → `UptimeStorage`
  - Migration tag: `v1` (new_sqlite_classes)

- **`cog/pushstatus.py`**
  - Discord bot integration example
  - Uses `discord.ext.tasks` for 60s loop
  - Posts `{"ping": <ms>}` to heartbeat endpoint
  - Reads `PUSHSTATUS_URL` and `PUSHTOKEN` from environment (never hardcode a real URL or token)

---

## Key Concepts

### 1. Heartbeats
- Bots POST to `/heartbeat` (or `/<botname>/heartbeat`) every ~60s
- Payload: `{"ping": <ms>}` (optional ping latency)
- Each heartbeat creates a `status: 1` entry with timestamp
- Resets offline tracking and schedules alarm for `lastHeartbeat + HEARTBEAT_TOLERANCE_SECONDS`

### 2. Synthetic Offline Detection
When a bot stops sending heartbeats, the system inserts synthetic offline markers using two mechanisms:

- **Alarm-based (timely)**:
  - DO alarm fires at `lastHeartbeat + 90s` (default tolerance)
  - Inserts `status: 0` entry with `insertionMode: "alarm"`
  - Most accurate, fires exactly when offline threshold is crossed

- **Fallback (read-side)**:
  - Triggered during `/status` read if bot is stale and no alarm marker exists
  - Inserts `status: 0` entry with `insertionMode: "fallback"` and `recordedAt`
  - Occurs when DO was cold or alarm didn't fire
  - `recordedAt - time` indicates insertion delay

### 3. Maintenance Mode
- Enable via `POST /maintenance/enable` (protected)
- Creates `status: 2` maintenance event
- Suppresses offline insertion (alarms and fallback)
- Returns `status: 2` in all endpoints until disabled
- Disable via `POST /maintenance/disable`

### 4. Uptime Metrics
Two uptime calculations over last 24 hours:

- **`uptime` (raw)**:
  - Slot-based: counts `status: 1` entries
  - Expected slots: `(24 * 60 * 60) / HEARTBEAT_INTERVAL_SECONDS` (1440 for 60s)
  - Formula: `(onlineCount / expectedSlots) * 100`, clamped to 100%
  - Use case: strict "what the store saw" metric

- **`uptimeAdjusted` (SLA-friendly)**:
  - Excludes late synthetic offline markers from denominator
  - "Late" = `(recordedAt - time) > LATE_OFFLINE_EXCLUSION_HOURS` (default 6h)
  - Only applies to `insertionMode: "fallback"` entries
  - Use case: avoid penalizing uptime when DO is cold or reads are infrequent

### 5. Multi-Bot Routing
- Default bot: `/api/status`, `/heartbeat`, `/maintenance/*` (uses `AUTH_TOKEN`)
- Named bots: `/<botname>/status` or `/<botname>/api/status`, `/<botname>/heartbeat` (uses `<botname>_auth` secret)
- Reserved top-level names: `api`, `heartbeat`, `maintenance` (they select the default bot)
- Bot names: max 64 chars; case-sensitive for storage, normalized for the secret name
- Each bot gets isolated Durable Object instance via `idFromName(botName)`
- Bot name normalization (secret lookup only): lowercase, replace non-alphanumeric with `_`

---

## Data Model

### In-Memory State (Durable Object)
```javascript
{
  heartbeats: [],                              // Array of events (newest-first)
  lastHeartbeat: { status: 1, time: "...", ping: 82 },
  maintenance: false,                          // Boolean maintenance flag
  lastOfflineRecordedForHeartbeatTime: "..."  // ISO timestamp or null
}
```

### Heartbeat Entry Types

**Status 1 (Online Heartbeat)**
```javascript
{
  status: 1,
  time: "2025-01-23T12:00:00.000Z",
  ping: 82  // optional, ms
}
```

**Status 0 (Synthetic Offline)**
```javascript
{
  status: 0,
  time: "2025-01-23T12:01:30.000Z",        // theoretical offline moment
  offline: true,
  for: "2025-01-23T12:00:00.000Z",         // last heartbeat that went stale
  insertionMode: "alarm" | "fallback",
  recordedAt: "2025-01-23T12:01:30.123Z"   // when marker was inserted
}
```

**Status 2 (Maintenance)**
```javascript
{
  status: 2,
  time: "2025-01-23T12:00:00.000Z",
  maintenance: true,
  event: "maintenance_start" | "maintenance_end"
}
```

### Constants (configurable in code)
```javascript
HEARTBEAT_TOLERANCE_SECONDS = 90     // Offline threshold
HEARTBEAT_INTERVAL_SECONDS = 60      // Expected cadence
RETENTION_MS = 48 * 60 * 60 * 1000  // 48h retention
```

### Environment Variables
- `AUTH_TOKEN` - Bearer token for default bot protected routes
- `<botname>_auth` - Per-bot bearer token (normalized name)
- `LATE_OFFLINE_EXCLUSION_HOURS` - Threshold for excluding late fallback markers (default: 6)

---

## API Routes

### Public Endpoints (no auth required)

#### `GET /api/health` or `GET /<botname>/api/health`
**Purpose**: Fast health check for monitors
**Returns**: HTTP 200 (ok) or 503 (offline)
**Response**:
```json
{
  "ok": true|false,
  "status": 0|1|2,
  "lastCheck": "2025-01-23T12:00:00.000Z"
}
```
**Notes**:
- `status: 2` (maintenance) returns 200
- Use `Cache-Control: no-cache` header to avoid stale responses

#### `GET /api/status` or `GET /<botname>/api/status`
**Purpose**: Full status with uptime and history
**Response**:
```json
{
  "status": 0|1|2,
  "uptime": 99.58,
  "uptimeAdjusted": 99.92,
  "lastCheck": "2025-01-23T12:00:00.000Z",
  "heartbeatList": [...]
}
```
**Notes**:
- Triggers fallback offline insertion if needed
- Returns last 24h of heartbeats in `heartbeatList`

#### `GET /api/history?limit=<n>` or `GET /<botname>/api/history?limit=<n>`
**Purpose**: Paginated event history
**Query params**: `limit` (default 100, max 1000)
**Response**:
```json
{
  "limit": 200,
  "count": 200,
  "total": 1440,
  "items": [...]
}
```

### Protected Endpoints (require `Authorization: Bearer <token>`)

#### `POST /heartbeat` or `POST /<botname>/heartbeat`
**Purpose**: Record heartbeat from bot
**Headers**:
- `Authorization: Bearer <AUTH_TOKEN>` (default bot)
- `Authorization: Bearer <botname_auth>` (named bot)
- `Content-Type: application/json`

**Body**:
```json
{
  "ping": 82  // optional, milliseconds
}
```
**Response**:
```json
{
  "success": true,
  "message": "Heartbeat recorded"
}
```

#### `POST /maintenance/enable` or `POST /<botname>/maintenance/enable`
**Purpose**: Enable maintenance mode
**Auth**: Same as heartbeat
**Response**:
```json
{
  "success": true,
  "message": "Maintenance mode enabled."
}
```

#### `POST /maintenance/disable` or `POST /<botname>/maintenance/disable`
**Purpose**: Disable maintenance mode
**Auth**: Same as heartbeat
**Response**: Same as enable

---

## Development Workflow

### Prerequisites
- Node.js (for wrangler CLI)
- Cloudflare account with Workers enabled
- `wrangler` CLI installed: `npm install -g wrangler`

### Local Development
```bash
# Install dependencies (wrangler)
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Run locally with miniflare
wrangler dev

# Test endpoints
curl http://localhost:8787/api/health
```

### Deployment
```bash
# Deploy to production
wrangler deploy

# Set secrets
wrangler secret put AUTH_TOKEN
wrangler secret put payment_bot_auth  # example per-bot secret

# View logs
wrangler tail
```

### Testing Changes

**Unit tests (no Cloudflare account needed)**:
```bash
npm install      # installs wrangler (dev dependency)
npm test         # node --test with an in-memory DO state double
npm run check    # wrangler deploy --dry-run (bundles without deploying)
```
Add a test in `test/worker.test.mjs` for any routing, auth, or input-handling change.

**Testing heartbeat flow**:
```bash
# Post heartbeat
curl -X POST \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"ping":82}' \
  https://your-domain.workers.dev/heartbeat

# Check status
curl -H 'Cache-Control: no-cache' \
  https://your-domain.workers.dev/api/status
```

**Testing multi-bot**:
```bash
# Set per-bot secret
wrangler secret put payment_bot_auth

# Post to named bot
curl -X POST \
  -H "Authorization: Bearer $PAYMENT_BOT_AUTH" \
  -H "Content-Type: application/json" \
  --data '{"ping":50}' \
  https://your-domain.workers.dev/payment-bot/heartbeat

# Check named bot status
curl https://your-domain.workers.dev/payment-bot/api/status
```

---

## Code Conventions

### Worker Pattern (worker.js)
- Single default export with `fetch(request, env)` handler
- Multi-bot routing via URL path parsing
- Auth check before forwarding to Durable Object
- Use `idFromName(botName)` for consistent bot-to-DO mapping
- Always forward with `new Request(forwardUrl, request)` to preserve headers

### Durable Object Pattern (`UptimeStorage` class in worker.js)
- Class-based with `constructor(state, env)`
- **CRITICAL**: Proper state initialization to avoid race conditions:
  ```javascript
  constructor(state, env) {
    this.initialized = false;
    this.initPromise = this.initializeState();
  }

  async initializeState() {
    const data = await this.state.storage.get([...]);
    // Load state
    this.initialized = true;
  }

  async fetch(request) {
    if (!this.initialized) await this.initPromise;
    // Handle request with fully-loaded state
  }
  ```
- Implement `fetch(request)` for HTTP routing - **always wait for initialization first**
- Implement `alarm()` for scheduled tasks - **always wait for initialization first**
- Use `state.storage.put()` for persistence (batch writes where possible)
- Helper method `jsonResponse(obj, status)` for consistent responses

### State Management
- Store minimal state: `heartbeats`, `lastHeartbeat`, `maintenance`, tracking flags
- Prune old entries via `pruneOld()` after modifications
- Batch storage writes: combine multiple puts in single `state.storage.put({})`
- Never mutate state without persisting

### Error Handling
- Alarm errors: catch and log to avoid retry storms
- JSON parsing: wrap in try-catch with fallback to empty object
- Always return valid Response objects
- Use appropriate HTTP status codes (200, 401, 404, 503)

### CORS
- All responses include `Access-Control-Allow-Origin: *`
- Handle OPTIONS preflight in worker
- Include necessary headers in preflight response

---

## Common Development Tasks

### Adding a New Endpoint

1. **Add route in Durable Object** (`uptime-storage.mjs`):
```javascript
// In UptimeStorage.fetch()
case '/new-endpoint':
  return this.handleNewEndpoint(request);
```

2. **Implement handler**:
```javascript
async handleNewEndpoint(request) {
  // Your logic here
  return this.jsonResponse({ data: "..." }, 200);
}
```

3. **Update worker routing if needed** (`worker.js`):
```javascript
// Add to actionPath mapping if needed
```

### Modifying Uptime Calculation

Edit `calculateUptime()` or `calculateUptimeAdjusted()` in `uptime-storage.mjs`:
- Access recent heartbeats via `recentList` parameter
- Filter based on `status`, `insertionMode`, timestamps
- Return percentage (0-100)

### Changing Tolerance/Interval

Modify constants in `uptime-storage.mjs` constructor:
```javascript
this.HEARTBEAT_TOLERANCE_SECONDS = 120;  // 2 minutes
this.HEARTBEAT_INTERVAL_SECONDS = 30;    // 30s cadence
```

**Impact**:
- Changes alarm scheduling
- Affects uptime slot calculations
- Update client heartbeat frequency to match

### Adding Per-Bot Configuration

Currently all bots share same constants. To add per-bot config:

1. Store config in Durable Object state:
```javascript
this.config = data.get('config') || { tolerance: 90, interval: 60 };
```

2. Use config values instead of constants:
```javascript
if (ageSec <= this.config.tolerance) status = 1;
```

3. Add endpoint to update config (protected route)

### Implementing Webhook Notifications

Add to `handleStatus()` after offline detection:
```javascript
if (status === 0 && previousStatus === 1) {
  await this.sendWebhook(env.WEBHOOK_URL, {
    event: 'offline',
    bot: botName,
    lastCheck: this.lastHeartbeat.time
  });
}
```

Store `previousStatus` in state to detect transitions.

---

## Security Considerations

### Authentication
- **Protected routes**: `/heartbeat`, `/maintenance/*`
- **Public routes**: `/api/status`, `/api/health`, `/api/history`
- Auth uses bearer tokens from Cloudflare secrets
- Tokens never logged or exposed in responses

### Per-Bot Secret Isolation
- Default bot: uses `AUTH_TOKEN`
- Named bots: use `<normalized_botname>_auth`
- No fallback to `AUTH_TOKEN` for named bots
- Prevents accidental token reuse across bots

### Secret Management
```bash
# Set via wrangler (never commit to git)
wrangler secret put AUTH_TOKEN
wrangler secret put payment_bot_auth

# Rotate secrets independently
wrangler secret put AUTH_TOKEN  # rotates only default bot
```

### Bot Name Normalization
- Prevents injection via bot names in secret lookup
- Regex: `/[^a-z0-9_]/g` replaced with `_`
- Examples:
  - `payment-bot` → `payment_bot_auth`
  - `My/Bot!` → `my_bot_auth`

### CORS Policy
- Currently allows all origins (`*`)
- Consider restricting in production:
```javascript
'Access-Control-Allow-Origin': 'https://your-dashboard.com'
```

---

## Integration Points

### Bot Client Integration
See `cog/pushstatus.py` for reference implementation:
- Use `tasks.loop(seconds=60)` or equivalent scheduler
- POST to `/heartbeat` with `Authorization` header
- Include `{"ping": <ms>}` in body for latency tracking
- Handle 401 (invalid token), retry on 5xx errors

### Dashboard Integration
See `Web Integration Guide.md` for detailed patterns:
- Poll `/api/health` every 30-60s for status indicators
- Fetch `/api/status` on page load for detailed metrics
- Use `/api/history?limit=200` for timeline views
- Display both `uptime` and `uptimeAdjusted` with tooltips
- Annotate synthetic offline markers by `insertionMode`

### External Monitors (UptimeRobot, etc.)
- Use `/api/health` endpoint
- Configure 30-60s check interval
- Alert on HTTP 503 status
- Include `Cache-Control: no-cache` header

---

## Testing Scenarios

### Scenario 1: Bot Goes Offline
1. Bot stops sending heartbeats
2. After 90s, DO alarm fires → inserts `status: 0` with `insertionMode: "alarm"`
3. `/api/status` returns `status: 0`, uptime decreases
4. `/api/health` returns 503

### Scenario 2: Cold Durable Object
1. Bot stops sending heartbeats
2. DO alarm doesn't fire (cold instance)
3. User fetches `/api/status` 10 minutes later
4. Fallback logic inserts `status: 0` with `insertionMode: "fallback"`, `recordedAt` shows delay
5. If delay > 6h, marker excluded from `uptimeAdjusted`

### Scenario 3: Maintenance Window
1. POST `/maintenance/enable`
2. Bot stops sending heartbeats (maintenance work)
3. No offline markers inserted (alarms suppressed)
4. `/api/status` returns `status: 2`, `uptime: 100`
5. POST `/maintenance/disable` to resume normal monitoring

### Scenario 4: Multi-Bot Setup
1. Default bot: POST `/heartbeat` with `AUTH_TOKEN`
2. Payment bot: POST `/payment-bot/heartbeat` with `payment_bot_auth`
3. Each bot gets isolated DO instance
4. Fetch `/api/status` (default) and `/payment-bot/api/status` independently

---

## Troubleshooting

### Issue: "No data" shown instead of offline status (CRITICAL - FIXED)
- **Cause**: Race condition in Durable Object state initialization. The constructor was loading state asynchronously without waiting, causing requests processed immediately after DO wake-up to see uninitialized state (`lastHeartbeat: null`, `heartbeats: []`)
- **Symptoms**: Frontend shows "no data" when bot goes offline; status returns `status: 0` with empty `heartbeatList` and `lastCheck: null`
- **Fix**: Implemented proper async state initialization pattern:
  - Added `initializeState()` method that awaits storage load
  - Added `initialized` flag and `initPromise` to track state
  - Both `fetch()` and `alarm()` now wait for `initPromise` before processing
- **Location**: `worker.js` (`initializeState()`, and the `await this.initPromise` guards in `fetch()` and `alarm()`)
- **Impact**: Ensures all requests see fully-loaded state, preventing "no data" display
- **Regression test**: "state survives a cold start" in `test/worker.test.mjs`

### Issue: Heartbeat returns 401
- **Cause**: Invalid or missing `Authorization` header
- **Fix**: Verify secret matches bot name normalization, check wrangler secret list

### Issue: Many fallback offline markers
- **Cause**: DO alarms not firing (cold instances, low traffic)
- **Fix**: Expected behavior for low-traffic bots; adjust `LATE_OFFLINE_EXCLUSION_HOURS` to ignore late markers

### Issue: Uptime shows >100%
- **Cause**: More heartbeats than expected slots (shouldn't happen with clamping)
- **Fix**: Check `calculateUptime()` includes `Math.min(..., 100)`

### Issue: Status shows online but health returns 503
- **Cause**: Request timing or cache issues
- **Fix**: Ensure `Cache-Control: no-cache` header; check both use same bot path

### Issue: DO state not persisting
- **Cause**: Missing `await state.storage.put()`
- **Fix**: Always await storage operations, verify migrations in wrangler.toml

---

## Performance Considerations

### Durable Object Limits
- Single DO instance per bot (serialized requests)
- Storage operations are async (always await)
- Alarm precision: ~1-2 seconds (not millisecond-accurate)

### Optimization Tips
- Use `/api/health` for frequent polling (minimal computation)
- Use `/api/status` sparingly (triggers fallback logic)
- Batch storage writes where possible
- Prune history aggressively (48h default is generous)

### Scaling
- Each bot name gets dedicated DO instance
- No cross-bot queries (by design)
- For 1000s of bots, consider monitoring DO costs
- Consider adding pagination cursor support for history

---

## Future Enhancement Ideas

### Short-term
- [ ] Cursor-based pagination for `/api/history` (e.g., `?after=<ISO>`)
- [ ] Per-bot config API for tolerance/interval
- [ ] Webhook notifications on status transitions
- [ ] Richer `/api/health` response with recent transitions

### Medium-term
- [ ] Duration-based uptime (sum offline time vs total time)
- [ ] Historical uptime trends (7d, 30d, 90d)
- [ ] Incident timeline API (group consecutive offline events)
- [ ] Bot registry/discovery endpoint

### Long-term
- [ ] Analytics dashboard (built-in UI)
- [ ] Alerting rules (Slack/Discord/email on offline)
- [ ] SLA tracking and reporting
- [ ] Multi-region deployment detection

---

## Code Style Guidelines

### JavaScript/ESM
- Use ESM imports/exports (`export class`, `export default`)
- Prefer `const` over `let` where possible
- Use async/await for asynchronous operations
- Arrow functions for callbacks and short methods
- Template literals for string interpolation

### Naming Conventions
- Classes: `PascalCase` (e.g., `UptimeStorage`)
- Methods: `camelCase` (e.g., `handleHeartbeat`)
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `HEARTBEAT_TOLERANCE_SECONDS`)
- Private helpers: prefix with `_` (not enforced, use sparingly)

### Comments
- Use JSDoc for public methods:
```javascript
/**
 * Calculates raw uptime percentage over last 24h
 * @param {Array} recentList - Heartbeat entries from last 24h
 * @returns {number} Uptime percentage (0-100)
 */
calculateUptime(recentList) { ... }
```
- Inline comments for non-obvious logic
- Document edge cases and invariants

### Error Messages
- User-facing: Clear, actionable (e.g., `"Unauthorized"`)
- Logs: Include context (e.g., `"Alarm error:", e`)
- Avoid exposing internal details in public responses

---

## Related Documentation

- **README.md**: User-facing setup and API reference
- **Web Integration Guide.md**: Dashboard/UI integration patterns
- **wrangler.toml**: Deployment configuration
- **Cloudflare Docs**: https://developers.cloudflare.com/workers/
- **Durable Objects Guide**: https://developers.cloudflare.com/durable-objects/

---

## Changelog

### Recent Changes
- **2026-09** - Pre-publication hardening: fixed `/api/history` always returning no items (`parseInt` radix bug), fixed `/<bot>/api/*` and top-level `/maintenance/*` routes returning 404, constant-time token compare, POST-only protected routes, heartbeat body validation, removed unused `uptime-storage.mjs`, added tests, CI (tests + gitleaks), `.gitignore`, `.dev.vars.example`, SECURITY.md
- **2025-01** - Added per-bot Cloudflare secrets support
- **2025-01** - Implemented `uptimeAdjusted` metric with late offline exclusion
- **2025-01** - Added `/api/health` endpoint for monitors
- **2025-01** - Added `/api/history` pagination endpoint
- **2025-01** - Enhanced synthetic offline with `insertionMode` and `recordedAt`

---

## Contact & Contribution

For issues or feature requests, see the repository's issue tracker or pull request guidelines.

When contributing:
- Follow existing code style and conventions
- Update relevant documentation (README, CLAUDE.md, Web Integration Guide)
- Test with `wrangler dev` before deploying
- Consider multi-bot and edge cases (maintenance mode, cold DO, etc.)

---

**Last Updated**: 2026-09-18
**Maintainer**: Penguin0011
**AI Assistant Note**: This document is optimized for AI code assistants. When working on this codebase, always refer to the architecture, data model, and development workflow sections above. Pay special attention to state management patterns and the dual offline detection mechanism (alarm + fallback).
