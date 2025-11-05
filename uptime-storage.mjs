export class UptimeStorage {
  constructor(state, env) {
    this.state = state;
    this.heartbeats = [];
    this.lastHeartbeat = null;
    this.maintenance = false; // <-- NEW: State for maintenance mode

    // Load all state from persistent storage on startup
    this.state.storage.get(['heartbeats', 'lastHeartbeat', 'maintenance']).then(data => {
      this.heartbeats = data.get('heartbeats') || [];
      this.lastHeartbeat = data.get('lastHeartbeat') || null;
      this.maintenance = data.get('maintenance') || false;
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
      // --- NEW: Endpoints to control maintenance mode ---
      case '/maintenance/enable':
        return this.handleMaintenance(true);
      case '/maintenance/disable':
        return this.handleMaintenance(false);
      default:
        return new Response('Not Found in Durable Object', { status: 404 });
    }
  }

  // --- NEW: Method to set maintenance mode ---
  async handleMaintenance(enable) {
    this.maintenance = enable;
    await this.state.storage.put('maintenance', this.maintenance); // Persist state
    return new Response(JSON.stringify({
      success: true,
      message: `Maintenance mode ${enable ? 'enabled' : 'disabled'}.`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  handleStatus() {
    // --- NEW: Check for maintenance mode first ---
    if (this.maintenance) {
      return new Response(JSON.stringify({
        status: 2, // Maintenance status
        uptime: 100, // Uptime is not degraded during planned maintenance
        lastCheck: this.lastHeartbeat?.time || null,
        heartbeatList: [], // Don't show heartbeats during maintenance
        message: "Bot is currently under planned maintenance."
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const HEARTBEAT_TOLERANCE = 90; // 90 seconds
    let status = 0; // Offline
    
    if (this.lastHeartbeat) {
      const timeSinceLast = (Date.now() - new Date(this.lastHeartbeat.time).getTime()) / 1000;
      if (timeSinceLast <= HEARTBEAT_TOLERANCE) {
        status = 1; // Online
      }
    }

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentHeartbeats = this.heartbeats.filter(hb => new Date(hb.time).getTime() >= oneDayAgo);
    
    const uptime = this.calculateUptime(recentHeartbeats);

    return new Response(JSON.stringify({
      status,
      uptime,
      lastCheck: this.lastHeartbeat?.time || null,
      heartbeatList: recentHeartbeats,
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  
  async handleHeartbeat(request) {
    const timestamp = new Date().toISOString();
    let requestData = {};
    try {
      if (request.headers.get('Content-Type')?.includes('application/json')) {
        requestData = await request.json();
      }
    } catch (e) { /* Ignore */ }

    const heartbeatData = {
      status: 1,
      time: timestamp,
      ping: requestData.ping !== undefined ? Math.round(requestData.ping) : undefined,
    };

    this.lastHeartbeat = heartbeatData;
    this.heartbeats.unshift(heartbeatData);

    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    this.heartbeats = this.heartbeats.filter(hb => new Date(hb.time).getTime() > twoDaysAgo);

    await this.state.storage.put({
      'lastHeartbeat': this.lastHeartbeat,
      'heartbeats': this.heartbeats,
    });
    
    return new Response(JSON.stringify({ success: true, message: 'Heartbeat recorded' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  calculateUptime(heartbeatList) {
    if (heartbeatList.length === 0) return 0;
    const HEARTBEAT_INTERVAL = 60;
    const expected = (24 * 60 * 60) / HEARTBEAT_INTERVAL;
    const percentage = Math.min((heartbeatList.length / expected) * 100, 100);
    return Math.round(percentage * 100) / 100;
  }
}