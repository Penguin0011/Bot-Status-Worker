export class UptimeStorage {
  constructor(state, env) {
    this.state = state;

    // In-memory state
    this.heartbeats = [];
    this.lastHeartbeat = null;
    this.maintenance = false;
    this.lastOfflineRecordedForHeartbeatTime = null;

    // Constants
    this.HEARTBEAT_TOLERANCE_SECONDS = 90; // Offline threshold
    this.HEARTBEAT_INTERVAL_SECONDS = 60; // Expected heartbeat cadence
    this.RETENTION_MS = 48 * 60 * 60 * 1000; // Keep last 48h of entries

    // Load all state from persistent storage on startup
    this.state.storage
      .get([
        'heartbeats',
        'lastHeartbeat',
        'maintenance',
        'lastOfflineRecordedForHeartbeatTime',
      ])
      .then((data) => {
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
      case '/heartbeat':
        return this.handleHeartbeat(request);
      case '/status':
        return this.handleStatus();
      case '/maintenance/enable':
        return this.handleMaintenance(true);
      case '/maintenance/disable':
        return this.handleMaintenance(false);
      default:
        return new Response('Not Found in Durable Object', { status: 404 });
    }
  }

  // Alarm callback used to detect and persist "offline" heartbeats
  async alarm() {
    try {
      if (this.maintenance) return;
      if (!this.lastHeartbeat) return;

      const lastTimeMs = new Date(this.lastHeartbeat.time).getTime();
      const ageMs = Date.now() - lastTimeMs;

      if (
        ageMs > this.HEARTBEAT_TOLERANCE_SECONDS * 1000 &&
        this.lastOfflineRecordedForHeartbeatTime !== this.lastHeartbeat.time
      ) {
        const offlineEntry = {
          status: 0,
            // Synthetic offline marker
          time: new Date().toISOString(),
          offline: true,
          for: this.lastHeartbeat.time
        };

        this.heartbeats.unshift(offlineEntry);
        this.pruneOld();

        this.lastOfflineRecordedForHeartbeatTime = this.lastHeartbeat.time;

        await this.state.storage.put({
          heartbeats: this.heartbeats,
          lastOfflineRecordedForHeartbeatTime:
            this.lastOfflineRecordedForHeartbeatTime
        });
      }
    } catch (e) {
      console.error('Alarm error:', e);
    }
  }

  async handleMaintenance(enable) {
    this.maintenance = enable;

    const now = new Date().toISOString();
    const maintenanceEvent = {
      status: 2,
      time: now,
      maintenance: true,
      event: enable ? 'maintenance_start' : 'maintenance_end'
    };

    this.heartbeats.unshift(maintenanceEvent);
    this.pruneOld();

    await this.state.storage.put({
      maintenance: this.maintenance,
      heartbeats: this.heartbeats
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Maintenance mode ${enable ? 'enabled' : 'disabled'}.`
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  handleStatus() {
    if (this.maintenance) {
      return new Response(
        JSON.stringify({
          status: 2,
          uptime: 100,
          lastCheck: this.lastHeartbeat?.time || null,
          heartbeatList: [],
          message: 'Bot is currently under planned maintenance.'
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    let status = 0;
    if (this.lastHeartbeat) {
      const timeSinceLastSeconds =
        (Date.now() - new Date(this.lastHeartbeat.time).getTime()) / 1000;
      if (timeSinceLastSeconds <= this.HEARTBEAT_TOLERANCE_SECONDS) {
        status = 1;
      }
    }

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentHeartbeats = this.heartbeats.filter(
      (hb) => new Date(hb.time).getTime() >= oneDayAgo
    );

    const uptime = this.calculateUptime(recentHeartbeats);

    return new Response(
      JSON.stringify({
        status,
        uptime,
        lastCheck: this.lastHeartbeat?.time || null,
        heartbeatList: recentHeartbeats
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }

  async handleHeartbeat(request) {
    const timestamp = new Date().toISOString();
    let requestData = {};
    try {
      if (request.headers.get('Content-Type')?.includes('application/json')) {
        requestData = await request.json();
      }
    } catch {}

    const heartbeatData = {
      status: 1,
      time: timestamp,
      ping:
        requestData.ping !== undefined
          ? Math.round(requestData.ping)
          : undefined
    };

    this.lastHeartbeat = heartbeatData;
    this.heartbeats.unshift(heartbeatData);
    this.lastOfflineRecordedForHeartbeatTime = null; // reset on new heartbeat
    this.pruneOld();

    await this.state.storage.put({
      lastHeartbeat: this.lastHeartbeat,
      heartbeats: this.heartbeats,
      lastOfflineRecordedForHeartbeatTime:
        this.lastOfflineRecordedForHeartbeatTime
    });

    await this.state.storage.setAlarm(
      Date.now() + this.HEARTBEAT_TOLERANCE_SECONDS * 1000
    );

    return new Response(
      JSON.stringify({ success: true, message: 'Heartbeat recorded' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  calculateUptime(heartbeatList) {
    if (!heartbeatList || heartbeatList.length === 0) return 0;

    const expected =
      (24 * 60 * 60) / this.HEARTBEAT_INTERVAL_SECONDS; // 1440 at 60s
    const onlineCount = heartbeatList.filter((hb) => hb.status === 1).length;
    const percentage = Math.min((onlineCount / expected) * 100, 100);
    return Math.round(percentage * 100) / 100;
  }

  pruneOld() {
    const cutoff = Date.now() - this.RETENTION_MS;
    this.heartbeats = this.heartbeats.filter(
      (hb) => new Date(hb.time).getTime() > cutoff
    );
  }
}