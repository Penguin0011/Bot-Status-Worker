var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// uptime-storage.mjs
var UptimeStorage = class {
  static {
    __name(this, "UptimeStorage");
  }
  constructor(state, env) {
    this.state = state;
    this.heartbeats = [];
    this.lastHeartbeat = null;
    this.maintenance = false;
    this.state.storage.get(["heartbeats", "lastHeartbeat", "maintenance"]).then((data) => {
      this.heartbeats = data.get("heartbeats") || [];
      this.lastHeartbeat = data.get("lastHeartbeat") || null;
      this.maintenance = data.get("maintenance") || false;
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    switch (path) {
      case "/heartbeat":
        return this.handleHeartbeat(request);
      case "/status":
        return this.handleStatus();
      // --- NEW: Endpoints to control maintenance mode ---
      case "/maintenance/enable":
        return this.handleMaintenance(true);
      case "/maintenance/disable":
        return this.handleMaintenance(false);
      default:
        return new Response("Not Found in Durable Object", { status: 404 });
    }
  }
  // --- NEW: Method to set maintenance mode ---
  async handleMaintenance(enable) {
    this.maintenance = enable;
    await this.state.storage.put("maintenance", this.maintenance);
    return new Response(JSON.stringify({
      success: true,
      message: `Maintenance mode ${enable ? "enabled" : "disabled"}.`
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  handleStatus() {
    if (this.maintenance) {
      return new Response(JSON.stringify({
        status: 2,
        // Maintenance status
        uptime: 100,
        // Uptime is not degraded during planned maintenance
        lastCheck: this.lastHeartbeat?.time || null,
        heartbeatList: [],
        // Don't show heartbeats during maintenance
        message: "Bot is currently under planned maintenance."
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    const HEARTBEAT_TOLERANCE = 90;
    let status = 0;
    if (this.lastHeartbeat) {
      const timeSinceLast = (Date.now() - new Date(this.lastHeartbeat.time).getTime()) / 1e3;
      if (timeSinceLast <= HEARTBEAT_TOLERANCE) {
        status = 1;
      }
    }
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1e3;
    const recentHeartbeats = this.heartbeats.filter((hb) => new Date(hb.time).getTime() >= oneDayAgo);
    const uptime = this.calculateUptime(recentHeartbeats);
    return new Response(JSON.stringify({
      status,
      uptime,
      lastCheck: this.lastHeartbeat?.time || null,
      heartbeatList: recentHeartbeats
    }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
  async handleHeartbeat(request) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    let requestData = {};
    try {
      if (request.headers.get("Content-Type")?.includes("application/json")) {
        requestData = await request.json();
      }
    } catch (e) {
    }
    const heartbeatData = {
      status: 1,
      time: timestamp,
      ping: requestData.ping !== void 0 ? Math.round(requestData.ping) : void 0
    };
    this.lastHeartbeat = heartbeatData;
    this.heartbeats.unshift(heartbeatData);
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1e3;
    this.heartbeats = this.heartbeats.filter((hb) => new Date(hb.time).getTime() > twoDaysAgo);
    await this.state.storage.put({
      "lastHeartbeat": this.lastHeartbeat,
      "heartbeats": this.heartbeats
    });
    return new Response(JSON.stringify({ success: true, message: "Heartbeat recorded" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  calculateUptime(heartbeatList) {
    if (heartbeatList.length === 0) return 0;
    const HEARTBEAT_INTERVAL = 60;
    const expected = 24 * 60 * 60 / HEARTBEAT_INTERVAL;
    const percentage = Math.min(heartbeatList.length / expected * 100, 100);
    return Math.round(percentage * 100) / 100;
  }
};

// worker.js
var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      } });
    }
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    let botName = "default";
    let actionPath = url.pathname;
    if (pathSegments.length === 0 || pathSegments.length === 1 && pathSegments[0] === "api") {
      return new Response("Not Found", { status: 404 });
    }
    if (pathSegments[0] === "api" && pathSegments[1] === "status") {
      actionPath = "/status";
    } else if (pathSegments[0] === "heartbeat" && pathSegments.length === 1) {
      actionPath = "/heartbeat";
    } else if (pathSegments.length >= 2) {
      botName = pathSegments[0];
      actionPath = "/" + pathSegments.slice(1).join("/");
    }
    if (actionPath.startsWith("/heartbeat") || actionPath.startsWith("/maintenance")) {
      const authHeader = request.headers.get("Authorization");
      if (!env.AUTH_TOKEN || authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
    }
    const doId = env.UPTIME_STORAGE.idFromName(botName);
    const stub = env.UPTIME_STORAGE.get(doId);
    return stub.fetch(new Request(url.origin + actionPath, request));
  }
};
export {
  UptimeStorage,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
