export class UptimeStorage {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // In-memory state
    this.heartbeats = [];
    this.lastHeartbeat = null;
    this.maintenance = false;
    this.lastOfflineRecordedForHeartbeatTime = null;

    // Constants (defaults, can be adjusted in-code or via env where noted)
    this.HEARTBEAT_TOLERANCE_SECONDS = 90;   // Offline threshold
    this.HEARTBEAT_INTERVAL_SECONDS = 60;    // Expected heartbeat cadence
    this.RETENTION_MS = 48 * 60 * 60 * 1000; // Keep last 48h of entries

    // Track whether state has been initialized
    this.initialized = false;
    this.initPromise = this.initializeState();
  }

  async initializeState() {
    // Load persisted data (Durable Object storage)
    const data = await this.state.storage.get([
      'heartbeats',
      'lastHeartbeat',
      'maintenance',
      'lastOfflineRecordedForHeartbeatTime'
    ]);

    this.heartbeats = data.get('heartbeats') || [];
    this.lastHeartbeat = data.get('lastHeartbeat') || null;
    this.maintenance = data.get('maintenance') || false;
    this.lastOfflineRecordedForHeartbeatTime =
      data.get('lastOfflineRecordedForHeartbeatTime') || null;

    this.initialized = true;
  }

  // helper to create JSON responses with consistent CORS
  jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // fetch entrypoint (routes inside the DO)
  async fetch(request) {
    // Ensure state is loaded before processing any request
    if (!this.initialized) {
      await this.initPromise;
    }

    const url = new URL(request.url);
    const path = url.pathname;

    switch (path) {
      case '/heartbeat': return this.handleHeartbeat(request);
      case '/status': return this.handleStatus(request);
      case '/health': return this.handleHealth(request);
      case '/history': return this.handleHistory(request);
      case '/maintenance/enable': return this.handleMaintenance(true);
      case '/maintenance/disable': return this.handleMaintenance(false);
      default: return new Response('Not Found in Durable Object', { status: 404 });
    }
  }

  // Alarm callback used to detect and persist "offline" heartbeats
  async alarm() {
    try {
      // Ensure state is loaded before processing alarm
      if (!this.initialized) {
        await this.initPromise;
      }

      if (this.maintenance) return;
      if (!this.lastHeartbeat) return;

      const lastTimeMs = new Date(this.lastHeartbeat.time).getTime();
      const ageMs = Date.now() - lastTimeMs;

      if (
        ageMs > this.HEARTBEAT_TOLERANCE_SECONDS * 1000 &&
        this.lastOfflineRecordedForHeartbeatTime !== this.lastHeartbeat.time
      ) {
        // The theoretical offline moment:
        const offlineTimeMs = lastTimeMs + this.HEARTBEAT_TOLERANCE_SECONDS * 1000;
        const now = new Date().toISOString();

        const offlineEntry = {
          status: 0,
          time: new Date(offlineTimeMs).toISOString(), // theoretical offline moment
          offline: true,
          for: this.lastHeartbeat.time,
          insertionMode: 'alarm',
          recordedAt: now
        };

        this.heartbeats.unshift(offlineEntry);
        this.lastOfflineRecordedForHeartbeatTime = this.lastHeartbeat.time;
        this.pruneOld();

        await this.state.storage.put({
          heartbeats: this.heartbeats,
          lastOfflineRecordedForHeartbeatTime: this.lastOfflineRecordedForHeartbeatTime
        });
      }
    } catch (e) {
      // avoid alarm retry storms
      console.error('Alarm error:', e);
    }
  }

  async handleMaintenance(enable) {
    this.maintenance = enable;

    const event = {
      status: 2,
      time: new Date().toISOString(),
      maintenance: true,
      event: enable ? 'maintenance_start' : 'maintenance_end'
    };

    this.heartbeats.unshift(event);
    this.pruneOld();

    await this.state.storage.put({
      maintenance: this.maintenance,
      heartbeats: this.heartbeats
    });

    return this.jsonResponse({
      success: true,
      message: `Maintenance mode ${enable ? 'enabled' : 'disabled'}.`
    }, 200);
  }

  // Health endpoint (minimal monitor-friendly)
  handleHealth() {
    if (this.maintenance) {
      return this.jsonResponse({ ok: true, status: 2, lastCheck: this.lastHeartbeat?.time || null }, 200);
    }

    let status = 0;
    if (this.lastHeartbeat) {
      const ageSec = (Date.now() - new Date(this.lastHeartbeat.time).getTime()) / 1000;
      if (ageSec <= this.HEARTBEAT_TOLERANCE_SECONDS) status = 1;
    }

    const ok = status === 1 || status === 2;
    return this.jsonResponse({ ok, status, lastCheck: this.lastHeartbeat?.time || null }, ok ? 200 : 503);
  }

  // History endpoint (paginated newest-first)
  handleHistory(request) {
    const url = new URL(request.url);
    const parsed = parseInt(url.searchParams.get('limit') || '100', 10);
    const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 100, 1), 1000);

    const items = this.heartbeats.slice(0, limit); // newest-first
    return this.jsonResponse({
      limit,
      count: items.length,
      total: this.heartbeats.length,
      items
    });
  }

  // Status endpoint returns status, uptime, uptimeAdjusted, lastCheck, heartbeatList
  async handleStatus() {
    // Maintenance short-circuit
    if (this.maintenance) {
      return this.jsonResponse({
        status: 2,
        uptime: 100,
        uptimeAdjusted: 100,
        lastCheck: this.lastHeartbeat?.time || null,
        heartbeatList: [],
        message: 'Bot is currently under planned maintenance.'
      }, 200);
    }

    // Compute status from last heartbeat age
    let status = 0;
    let ageSec = Infinity;
    let lastTimeMs = 0;
    if (this.lastHeartbeat) {
      lastTimeMs = new Date(this.lastHeartbeat.time).getTime();
      ageSec = (Date.now() - lastTimeMs) / 1000;
      if (ageSec <= this.HEARTBEAT_TOLERANCE_SECONDS) status = 1;
    }

    // Fallback: if offline and the alarm hasn't inserted an offline marker yet,
    // create one now so the UI/history shows the transition reliably.
    if (
      status === 0 &&
      this.lastHeartbeat &&
      this.lastOfflineRecordedForHeartbeatTime !== this.lastHeartbeat.time
    ) {
      const lastTimeMsLocal = new Date(this.lastHeartbeat.time).getTime();
      const offlineTimeMs = lastTimeMsLocal + this.HEARTBEAT_TOLERANCE_SECONDS * 1000;
      const now = new Date().toISOString();

      const offlineEntry = {
        status: 0,
        time: new Date(offlineTimeMs).toISOString(),
        offline: true,
        for: this.lastHeartbeat.time,
        insertionMode: 'fallback',
        recordedAt: now
      };
      this.heartbeats.unshift(offlineEntry);
      this.lastOfflineRecordedForHeartbeatTime = this.lastHeartbeat.time;
      this.pruneOld();

      // Persist so subsequent reads see it without needing the alarm
      await this.state.storage.put({
        heartbeats: this.heartbeats,
        lastOfflineRecordedForHeartbeatTime: this.lastOfflineRecordedForHeartbeatTime
      });
    }

    // Uptime over last 24h, using slot-based raw uptime (status===1 counts)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.heartbeats.filter(h => new Date(h.time).getTime() >= oneDayAgo);
    const uptime = this.calculateUptime(recent);

    // Compute uptimeAdjusted: exclude very-late synthetic offline markers from denominator
    const lateExclusionHours = parseFloat(this.env.LATE_OFFLINE_EXCLUSION_HOURS) || 6;
    const uptimeAdjusted = this.calculateUptimeAdjusted(recent, lateExclusionHours);

    return this.jsonResponse({
      status,
      uptime,
      uptimeAdjusted,
      lastCheck: this.lastHeartbeat?.time || null,
      heartbeatList: recent
    }, 200);
  }

  async handleHeartbeat(request) {
    const timestamp = new Date().toISOString();
    let body = {};
    try {
      if (request.headers.get('Content-Type')?.includes('application/json')) {
        const parsed = await request.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
      }
    } catch (e) {}

    // Only accept a finite numeric ping; anything else is dropped rather than stored as NaN/null.
    const ping = typeof body.ping === 'number' && Number.isFinite(body.ping) ? Math.round(body.ping) : undefined;
    const hb = { status: 1, time: timestamp, ping };

    this.lastHeartbeat = hb;
    this.heartbeats.unshift(hb);
    // Reset offline transition tracking on new heartbeat
    this.lastOfflineRecordedForHeartbeatTime = null;
    this.pruneOld();

    await this.state.storage.put({
      lastHeartbeat: this.lastHeartbeat,
      heartbeats: this.heartbeats,
      lastOfflineRecordedForHeartbeatTime: this.lastOfflineRecordedForHeartbeatTime
    });

    // Schedule offline check (alarm)
    await this.state.storage.setAlarm(Date.now() + this.HEARTBEAT_TOLERANCE_SECONDS * 1000);

    return this.jsonResponse({ success: true, message: 'Heartbeat recorded' }, 200);
  }

  // Only count status === 1 heartbeats towards uptime (slot-based)
  calculateUptime(list) {
    if (!list || !list.length) return 0;
    const expected = (24 * 60 * 60) / this.HEARTBEAT_INTERVAL_SECONDS; // 1440 for 60s
    const online = list.filter(h => h.status === 1).length;
    const pct = Math.min((online / expected) * 100, 100);
    return Math.round(pct * 100) / 100;
  }

  // Compute uptimeAdjusted by excluding late synthetic offline markers from the denominator.
  // This follows the README: if a synthetic offline (fallback) was recorded long after the theoretical offline time,
  // treat that slot as excluded from the denominator (don't penalize SLA).
  calculateUptimeAdjusted(recentList, lateExclusionHours) {
    if (!recentList || !recentList.length) return 0;
    const expected = (24 * 60 * 60) / this.HEARTBEAT_INTERVAL_SECONDS; // 1440

    const online = recentList.filter(h => h.status === 1).length;

    // Count late fallback synthetic offline markers within the 24h window
    const lateThresholdMs = lateExclusionHours * 60 * 60 * 1000;
    const lateFallbackCount = recentList.filter(h =>
      h.status === 0 &&
      h.insertionMode === 'fallback' &&
      h.recordedAt &&
      (new Date(h.recordedAt).getTime() - new Date(h.time).getTime()) > lateThresholdMs
    ).length;

    const adjustedExpected = Math.max(expected - lateFallbackCount, 1);
    const pct = Math.min((online / adjustedExpected) * 100, 100);
    return Math.round(pct * 100) / 100;
  }

  // Prune to retention window
  pruneOld() {
    const cutoff = Date.now() - this.RETENTION_MS;
    this.heartbeats = this.heartbeats.filter(h => new Date(h.time).getTime() > cutoff);
  }
}

// Path segments that can never be bot names because they select the default bot.
const RESERVED_TOP_LEVEL = new Set(['api', 'heartbeat', 'maintenance']);
// Actions the Durable Object understands; anything else is rejected before a DO is touched.
const KNOWN_ACTIONS = new Set(['/heartbeat', '/status', '/health', '/history', '/maintenance/enable', '/maintenance/disable']);
const MAX_BOT_NAME_LENGTH = 64;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

/**
 * Constant-time string comparison so bearer-token checks don't leak
 * how many leading characters matched through response timing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  let diff = bufA.length ^ bufB.length;
  const len = Math.max(bufA.length, bufB.length);
  for (let i = 0; i < len; i++) {
    diff |= (bufA[i % bufA.length] ?? 0) ^ (bufB[i % bufB.length] ?? 0);
  }
  return diff === 0;
}

/**
 * Resolves a request path to a bot name and the action to forward to its Durable Object.
 * Supported shapes (see README):
 *   /api/<action>           -> default bot
 *   /heartbeat, /maintenance/<x> -> default bot
 *   /<bot>/<action>         -> named bot
 *   /<bot>/api/<action>     -> named bot (the "api" prefix is optional for named bots)
 * @param {string} pathname
 * @returns {{ botName: string, actionPath: string } | null} null when the path is not routable
 */
export function resolveRoute(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  let botName = 'default';
  let rest = segments;

  if (!RESERVED_TOP_LEVEL.has(segments[0])) {
    // Multi-bot path: /<botname>/...
    botName = segments[0];
    rest = segments.slice(1);
    if (botName.length > MAX_BOT_NAME_LENGTH) return null;
  }

  // Optional "api" prefix: /api/status, /<bot>/api/status
  if (rest[0] === 'api') rest = rest.slice(1);
  if (rest.length === 0) return null;

  const actionPath = '/' + rest.join('/');
  if (!KNOWN_ACTIONS.has(actionPath)) return null;
  return { botName, actionPath };
}

// Worker entrypoint with multi-bot routing (/:bot/... support)
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const route = resolveRoute(url.pathname);
    if (!route) {
      return new Response('Not Found', { status: 404 });
    }
    const { botName, actionPath } = route;

    // Protected routes require auth: heartbeat and maintenance actions.
    const protectedPrefixes = ['/heartbeat', '/maintenance'];
    if (protectedPrefixes.some(p => actionPath.startsWith(p))) {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: 'POST', ...CORS_HEADERS }
        });
      }
      const authHeader = request.headers.get('Authorization') || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      // Per-bot secret naming: "<botname>_auth"
      // Normalize botName to lowercase and replace non-alphanum with underscore to form the env var name:
      const normalizedBotName = botName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const secretName = `${normalizedBotName}_auth`;

      // Default bot keeps using env.AUTH_TOKEN
      let token = null;
      if (botName === 'default') {
        token = env.AUTH_TOKEN || null;
      } else {
        token = env[secretName] || null;
      }

      if (!token || bearer === null || !timingSafeEqual(bearer, token)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    const id = env.UPTIME_STORAGE.idFromName(botName);
    const stub = env.UPTIME_STORAGE.get(id);

    // Forward request into the Durable Object, remapping the path to the DO's internal path
    // Preserve querystring for /history etc.
    const forwardUrl = new URL(request.url);
    forwardUrl.pathname = actionPath;
    const forwarded = new Request(forwardUrl.toString(), request);
    return stub.fetch(forwarded);
  }
}