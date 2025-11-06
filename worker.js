export class UptimeStorage {
  constructor(state, env) {
    this.state = state;

    // In-memory state
    this.heartbeats = [];
    this.lastHeartbeat = null;
    this.maintenance = false;
    this.lastOfflineRecordedForHeartbeatTime = null;

    // Constants
    this.HEARTBEAT_TOLERANCE_SECONDS = 90;   // Offline threshold
    this.HEARTBEAT_INTERVAL_SECONDS = 60;    // Expected heartbeat cadence
    this.RETENTION_MS = 48 * 60 * 60 * 1000; // Keep last 48h of entries

    // Load persisted data
    this.state.storage.get([
      'heartbeats',
      'lastHeartbeat',
      'maintenance',
      'lastOfflineRecordedForHeartbeatTime'
    ]).then(data => {
      this.heartbeats = data.get('heartbeats') || [];
      this.lastHeartbeat = data.get('lastHeartbeat') || null;
      this.maintenance = data.get('maintenance') || false;
      this.lastOfflineRecordedForHeartbeatTime =
        data.get('lastOfflineRecordedForHeartbeatTime') || null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    switch (path) {
      case '/heartbeat': return this.handleHeartbeat(request);
      case '/status': return this.handleStatus();
      case '/maintenance/enable': return this.handleMaintenance(true);
      case '/maintenance/disable': return this.handleMaintenance(false);
      default: return new Response('Not Found in Durable Object', { status: 404 });
    }
  }

  // Alarm for offline transition
  async alarm() {
    try {
      console.log('ALARM fired; lastHeartbeat=', this.lastHeartbeat?.time);
      if (this.maintenance) return; // Do not mark offline during maintenance
      if (!this.lastHeartbeat) return;

      const lastTimeMs = new Date(this.lastHeartbeat.time).getTime();
      const ageMs = Date.now() - lastTimeMs;

      if (
        ageMs > this.HEARTBEAT_TOLERANCE_SECONDS * 1000 &&
        this.lastOfflineRecordedForHeartbeatTime !== this.lastHeartbeat.time
      ) {
        const offlineEntry = {
          status: 0,
          time: new Date().toISOString(),
          offline: true,
          // reference the online heartbeat that went stale
          for: this.lastHeartbeat.time
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

    return new Response(JSON.stringify({
      success: true,
      message: `Maintenance mode ${enable ? 'enabled' : 'disabled'}.`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

    // REPLACE the entire handleStatus with this async version
  async handleStatus() {
    // Maintenance short-circuit
    if (this.maintenance) {
      return new Response(JSON.stringify({
        status: 2,
        uptime: 100,
        lastCheck: this.lastHeartbeat?.time || null,
        heartbeatList: [],
        message: 'Bot is currently under planned maintenance.'
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
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
      const offlineTimeMs = lastTimeMs + this.HEARTBEAT_TOLERANCE_SECONDS * 1000;
      const offlineEntry = {
        status: 0,
        time: new Date(offlineTimeMs).toISOString(),
        offline: true,
        for: this.lastHeartbeat.time
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

    // Uptime over last 24h, counting only status === 1
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.heartbeats.filter(h => new Date(h.time).getTime() >= oneDayAgo);
    const uptime = this.calculateUptime(recent);

    return new Response(JSON.stringify({
      status,
      uptime,
      lastCheck: this.lastHeartbeat?.time || null,
      heartbeatList: recent
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  async handleHeartbeat(request) {
    const timestamp = new Date().toISOString();
    let body = {};
    try {
      if (request.headers.get('Content-Type')?.includes('application/json')) {
        body = await request.json();
      }
    } catch {}

    const hb = {
      status: 1,
      time: timestamp,
      ping: body.ping !== undefined ? Math.round(body.ping) : undefined
    };

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

    // Schedule offline check
    await this.state.storage.setAlarm(Date.now() + this.HEARTBEAT_TOLERANCE_SECONDS * 1000);

    return new Response(JSON.stringify({ success: true, message: 'Heartbeat recorded' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Only count status === 1 heartbeats towards uptime
  calculateUptime(list) {
    if (!list.length) return 0;
    const expected = (24 * 60 * 60) / this.HEARTBEAT_INTERVAL_SECONDS; // 1440
    const online = list.filter(h => h.status === 1).length;
    const pct = Math.min((online / expected) * 100, 100);
    return Math.round(pct * 100) / 100;
  }

  // Prune to 48h
  pruneOld() {
    const cutoff = Date.now() - this.RETENTION_MS;
    this.heartbeats = this.heartbeats.filter(
      h => new Date(h.time).getTime() > cutoff
    );
  }
}

// Worker entrypoint with multi-bot routing (/:bot/... support)
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    let botName = 'default';
    let actionPath = url.pathname;

    if (segments.length === 0 || (segments.length === 1 && segments[0] === 'api')) {
      return new Response('Not Found', { status: 404 });
    }

    if (segments[0] === 'api' && segments[1] === 'status') {
      actionPath = '/status';
    } else if (segments[0] === 'heartbeat' && segments.length === 1) {
      actionPath = '/heartbeat';
    } else if (segments.length >= 2) {
      botName = segments[0];
      actionPath = '/' + segments.slice(1).join('/');
    }

    // Auth for protected routes
    if (actionPath.startsWith('/heartbeat') || actionPath.startsWith('/maintenance')) {
      const authHeader = request.headers.get('Authorization');
      if (!env.AUTH_TOKEN || authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }
    }

    const id = env.UPTIME_STORAGE.idFromName(botName);
    const stub = env.UPTIME_STORAGE.get(id);
    return stub.fetch(new Request(url.origin + actionPath, request));
  }
}