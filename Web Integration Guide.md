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
  "uptime": 99.5,
  "lastCheck": "2024-11-02T08:00:00.000Z",
  "heartbeatList": [
    {
      "status": 1,
      "time": "2024-11-02T08:00:00.000Z",
      "ping": 45
    }
  ]
}
```

## Field Interpretations

### `status` (number)
Current bot state. Display logic:

| Value | Meaning | Color | Text |
|-------|---------|-------|------|
| `0` | Offline | Red (#ef4444) | "Offline" or "Down" |
| `1` | Online | Green (#22c55e) | "Online" or "Operational" |
| `2` | Maintenance | Orange (#f59e0b) | "Maintenance" or "Scheduled Maintenance" |

**Implementation:**
```javascript
const statusConfig = {
  0: { text: 'Offline', color: '#ef4444', icon: '🔴' },
  1: { text: 'Online', color: '#22c55e', icon: '🟢' },
  2: { text: 'Maintenance', color: '#f59e0b', icon: '🟠' }
};
const config = statusConfig[data.status] || statusConfig[0];
```

### `uptime` (number, 0-100)
Percentage of successful heartbeats in last 24 hours.

**Display Guidelines:**
- Round to 1-2 decimal places: `99.5%` or `99.52%`
- Color coding:
  - ≥99.5%: Green (excellent)
  - ≥95.0%: Yellow (acceptable)
  - <95.0%: Red (poor)

**Example:**
```javascript
const uptimeColor = uptime >= 99.5 ? '#22c55e' : uptime >= 95 ? '#f59e0b' : '#ef4444';
```

**Context Labels:**
- 100%: "Perfect uptime"
- 99-99.9%: "Excellent"
- 95-98.9%: "Good"
- <95%: "Degraded" or "Issues detected"

### `lastCheck` (string | null)
ISO 8601 timestamp of last heartbeat.

**Display Options:**
1. **Relative time:** "2 minutes ago", "1 hour ago"
2. **Absolute time:** "Nov 2, 2024 8:00 AM"
3. **Time since:** "Last seen: 2m ago"

**Handle null:**
- Display: "Never" or "No data" or "Not yet online"
- This means bot has never sent a heartbeat

**Implementation:**
```javascript
const lastSeen = data.lastCheck 
  ? formatRelativeTime(new Date(data.lastCheck))
  : 'Never';
```

### `heartbeatList` (array)
Historical heartbeats from last 24 hours (newest first).

**Use Cases:**
1. **Uptime chart:** Plot `time` (x-axis) vs continuous uptime
2. **Ping graph:** Plot `ping` values over time
3. **Incident timeline:** Show gaps where heartbeats are missing
4. **Status history:** Display recent up/down events

**Each item contains:**
- `status`: Always `1` (historical heartbeats are successful)
- `time`: ISO 8601 timestamp
- `ping`: Discord API latency in ms (optional, may be undefined)

## Example Implementation

### Minimal Status Badge

```html
<div id="bot-status">
  <span id="status-indicator"></span>
  <span id="status-text"></span>
  <span id="uptime-text"></span>
</div>
```

```javascript
async function updateStatus() {
  const res = await fetch('https://YOUR-WORKER.workers.dev/api/status');
  const data = await res.json();
  
  const statusMap = {
    0: { text: 'Offline', color: '#ef4444' },
    1: { text: 'Online', color: '#22c55e' },
    2: { text: 'Maintenance', color: '#f59e0b' }
  };
  
  const status = statusMap[data.status] || statusMap[0];
  
  document.getElementById('status-indicator').style.backgroundColor = status.color;
  document.getElementById('status-text').textContent = status.text;
  document.getElementById('uptime-text').textContent = `${data.uptime.toFixed(2)}% uptime`;
}

// Update every 30 seconds
setInterval(updateStatus, 30000);
updateStatus();
```

### Status Page with History

```javascript
async function buildStatusPage() {
  const res = await fetch('https://YOUR-WORKER.workers.dev/api/status');
  const data = await res.json();
  
  // Current status
  const statusInfo = {
    0: { text: 'Offline', color: 'red', message: 'Bot is currently offline' },
    1: { text: 'Online', color: 'green', message: 'All systems operational' },
    2: { text: 'Maintenance', color: 'orange', message: 'Scheduled maintenance in progress' }
  }[data.status];
  
  // Display current status
  displayStatus(statusInfo);
  
  // Display uptime
  const uptimeQuality = data.uptime >= 99.5 ? 'Excellent' :
                        data.uptime >= 95 ? 'Good' : 'Degraded';
  displayUptime(data.uptime, uptimeQuality);
  
  // Display last check
  const lastSeen = data.lastCheck 
    ? formatRelativeTime(data.lastCheck)
    : 'Never';
  displayLastCheck(lastSeen);
  
  // Build uptime chart from heartbeatList
  if (data.heartbeatList.length > 0) {
    buildUptimeChart(data.heartbeatList);
  }
  
  // Build ping graph if ping data exists
  const pings = data.heartbeatList
    .filter(h => h.ping !== undefined)
    .map(h => ({ time: h.time, ping: h.ping }));
  if (pings.length > 0) {
    buildPingChart(pings);
  }
}
```

## Common UI Patterns

### 1. Status Indicator Dot
```css
.status-dot {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin-right: 8px;
}
.status-online { background: #22c55e; }
.status-offline { background: #ef4444; }
.status-maintenance { background: #f59e0b; }
```

### 2. Uptime Bar
```html
<!-- Show 24h timeline with up/down segments -->
<div class="uptime-bar">
  <!-- Generate segments from heartbeatList -->
</div>
```

### 3. Ping Graph
```javascript
// Extract ping values
const pingData = data.heartbeatList
  .filter(h => h.ping)
  .map(h => ({ x: new Date(h.time), y: h.ping }));

// Chart ping over time (lower is better)
// Typical range: 20-100ms
// >200ms = yellow warning
// >500ms = red alert
```

## Edge Cases to Handle

### No Data Yet
```json
{
  "status": 0,
  "uptime": 0,
  "lastCheck": null,
  "heartbeatList": []
}
```
**Display:** "Bot has not started yet" or "Waiting for first heartbeat"

### Recently Started (<24h data)
- `uptime` may be low (e.g., 5%)
- `heartbeatList` has fewer than 1440 items
- Calculate actual uptime from available data
- Display note: "Bot started recently, uptime based on X hours"

### After Maintenance
- `status` changes from `2` → `1` when maintenance ends
- `uptime` may have dropped during maintenance window
- Consider showing maintenance window separately from unplanned downtime

### Long Offline Period
```json
{
  "status": 0,
  "uptime": 0,
  "lastCheck": "2024-10-01T12:00:00.000Z",
  "heartbeatList": []
}
```
- All heartbeats expired (48h+ old)
- Display: "Last seen: [date]" + "Offline for X days"

## Refresh Strategy

**Recommended:** Poll every 30-60 seconds

```javascript
// Update every 30 seconds
setInterval(updateStatus, 30000);

// Or use exponential backoff if offline
let interval = 30000;
const updateWithBackoff = () => {
  updateStatus().then(data => {
    interval = data.status === 0 ? Math.min(interval * 1.5, 300000) : 30000;
    setTimeout(updateWithBackoff, interval);
  });
};
```

## Accessibility

- Use semantic HTML for status indicators
- Include ARIA labels for screen readers
- Ensure color is not the only indicator (use icons/text too)
- Provide text descriptions for all visual status elements

```html
<div role="status" aria-live="polite">
  <span class="status-dot status-online" aria-label="Status indicator"></span>
  <span>Bot is <strong>Online</strong></span>
  <span aria-label="Uptime percentage">99.5% uptime</span>
</div>
```

## Testing Your Integration

1. **Mock responses** for all status values (0, 1, 2)
2. **Test null values** (lastCheck, missing ping data)
3. **Test empty arrays** (heartbeatList: [])
4. **Simulate network failures** (API timeout, CORS errors)
5. **Verify refresh intervals** work correctly
6. **Check accessibility** with screen readers

## Quick Reference

```javascript
// Fetch status
const res = await fetch('https://YOUR-WORKER.workers.dev/api/status');
const { status, uptime, lastCheck, heartbeatList } = await res.json();

// Interpret status
const isOnline = status === 1;
const isOffline = status === 0;
const isMaintenance = status === 2;

// Format uptime
const uptimeText = `${uptime.toFixed(1)}%`;

// Format last check
const lastSeenText = lastCheck 
  ? new Date(lastCheck).toLocaleString()
  : 'Never';

// Count heartbeats
const heartbeatsInLast24h = heartbeatList.length;

// Get average ping (if available)
const pings = heartbeatList.filter(h => h.ping).map(h => h.ping);
const avgPing = pings.length > 0 
  ? (pings.reduce((a, b) => a + b) / pings.length).toFixed(0)
  : 'N/A';
```
