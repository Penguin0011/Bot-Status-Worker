# Web Integration Guide - Bot Status API

**For AI/Developers building status display websites**

## API Endpoint

```
GET https://YOUR-WORKER.workers.dev/api/status
```

No authentication required. CORS enabled.

## Response Format

```json
{
  "status": 1,
  "uptime": 99.52,
  "lastCheck": "2025-01-01T10:00:00.000Z",
  "heartbeatList": [
    {
      "status": 1,
      "time": "2025-01-01T10:00:00.000Z",
      "ping": 45
    },
    {
      "status": 0,
      "time": "2025-01-01T09:30:30.000Z",
      "offline": true,
      "for": "2025-01-01T09:29:00.000Z"
    },
    {
      "status": 2,
      "time": "2025-01-01T08:00:00.000Z",
      "maintenance": true,
      "event": "maintenance_start"
    },
    {
      "status": 2,
      "time": "2025-01-01T08:30:00.000Z",
      "maintenance": true,
      "event": "maintenance_end"
    }
  ]
}
```

## Field Interpretations

### `status`
Current live state:
| Value | Meaning      | Color        | Text          |
|-------|--------------|--------------|---------------|
| 0     | Offline      | Red (#ef4444)| Offline       |
| 1     | Online       | Green (#22c55e)| Online      |
| 2     | Maintenance  | Orange (#f59e0b)| Maintenance |

### Synthetic Heartbeat Fields
- `offline: true` + `status: 0`: A recorded offline transition (inserted once when tolerance exceeded). `for` points to the last online heartbeat time.
- `maintenance: true` + `status: 2`: A maintenance transition event. `event` is one of:
  - `maintenance_start`
  - `maintenance_end`

These appear in `heartbeatList` only when maintenance is not actively enabled (during active maintenance the list is intentionally hidden).

### `uptime`
Percentage of ONLINE (status=1) heartbeats vs expected (1440 per 24h at 60s interval). Synthetic offline or maintenance entries are excluded from uptime math.

### `lastCheck`
Timestamp of the most recent real (status=1) heartbeat.

### `heartbeatList`
Newest first. May include:
- Real heartbeats: `{status:1,time,...,ping?}`
- Offline markers: `{status:0,offline:true,for:<iso>}`
- Maintenance markers: `{status:2,maintenance:true,event:'maintenance_start'|'maintenance_end'}`

## Visual Strategies

### Timeline Rendering
1. Sort by time ascending to build a 24h bar.
2. Mark segments:
   - Online minute → green.
   - Offline marker → start a red segment until next online heartbeat.
   - Maintenance start → orange segment until maintenance end.

### Distinguishing Maintenance vs Outage
If a maintenance window exists (start/end pair), treat that duration separately:
- Show “Scheduled Maintenance” badge.
- Exclude maintenance duration from downtime charts if you want “unplanned” MTTR.

### Minimal Badge

```javascript
async function updateStatus() {
  const res = await fetch('https://YOUR-WORKER.workers.dev/api/status');
  const data = await res.json();

  const statusMap = {
    0: { text: 'Offline', color: '#ef4444' },
    1: { text: 'Online', color: '#22c55e' },
    2: { text: 'Maintenance', color: '#f59e0b' }
  };

  const s = statusMap[data.status] || statusMap[0];
  document.getElementById('status-indicator').style.backgroundColor = s.color;
  document.getElementById('status-text').textContent = s.text;
  document.getElementById('uptime-text').textContent = `${data.uptime.toFixed(2)}% uptime`;
}
setInterval(updateStatus, 30000);
updateStatus();
```

### Parsing Synthetic Events

```javascript
function classifyHeartbeat(h) {
  if (h.offline) return { type: 'offline', time: h.time, for: h.for };
  if (h.maintenance) return { type: h.event, time: h.time };
  return { type: 'online', time: h.time, ping: h.ping };
}

const events = data.heartbeatList.map(classifyHeartbeat);
```

### Computing Downtime (Unplanned Only)

```javascript
function computeUnplannedDowntime(events) {
  // We consider periods after an offline marker until the next 'online' event
  let totalMs = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'offline') {
      // Look forward for next online
      const start = new Date(events[i].time).getTime();
      let end = Date.now();
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].type === 'online') {
          end = new Date(events[j].time).getTime();
          break;
        }
        if (events[j].type === 'maintenance_start') {
          // Stop counting unplanned downtime once maintenance starts (optional rule)
          end = new Date(events[j].time).getTime();
          break;
        }
      }
      totalMs += Math.max(0, end - start);
    }
  }
  return totalMs;
}
```

## Edge Cases

### Active Maintenance
Response hides heartbeatList; you may request again after maintenance end to rebuild history.

### Rapid Flapping
Multiple offline segments will still produce only one offline marker per missed window because a new online heartbeat resets tracking.

### No Heartbeats Yet
Show “Waiting for first heartbeat”.

## Refresh Strategy
- Poll every 30–60s.
- Backoff when offline:
```javascript
let interval = 30000;
async function loop() {
  const res = await fetch('.../api/status');
  const data = await res.json();
  interval = data.status === 0 ? Math.min(interval * 1.5, 300000) : 30000;
  setTimeout(loop, interval);
}
loop();
```

## Accessibility
Use text + color + icons (e.g., 🔴 🟢 🟠) with `aria-live="polite"` for status updates.

## Testing Checklist
1. Simulate online heartbeat stream.
2. Stop heartbeats → verify offline marker appears after ~90s.
3. Resume heartbeats → marker stops; uptime recovers gradually.
4. Maintenance enable/disable → events recorded correctly.
5. Verify uptime excludes synthetic (status 0 & 2) events.

## Quick Reference

```javascript
const { status, uptime, lastCheck, heartbeatList } = data;

const syntheticCounts = {
  offline: heartbeatList.filter(h => h.offline).length,
  maintenanceEvents: heartbeatList.filter(h => h.maintenance).length
};

const onlineHeartbeats = heartbeatList.filter(h => h.status === 1).length;
```