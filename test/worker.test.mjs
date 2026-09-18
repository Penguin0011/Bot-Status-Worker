// Unit tests for the worker router/auth and the Durable Object handlers.
// They run under plain `node --test` with an in-memory stand-in for DurableObjectState,
// so no Cloudflare account or wrangler dev server is required.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker, { UptimeStorage, resolveRoute, timingSafeEqual } from '../worker.js';

// ---- minimal Durable Object test doubles -----------------------------------
class MemoryStorage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(keys) {
    if (Array.isArray(keys)) return new Map(keys.map(k => [k, this.map.get(k)]));
    return this.map.get(keys);
  }
  async put(objOrKey, value) {
    if (typeof objOrKey === 'object') for (const [k, v] of Object.entries(objOrKey)) this.map.set(k, structuredClone(v));
    else this.map.set(objOrKey, structuredClone(value));
  }
  async setAlarm(t) { this.alarm = t; }
}
const makeState = () => ({ storage: new MemoryStorage() });

class FakeNamespace {
  constructor(env) { this.env = env; this.instances = new Map(); this.requested = []; }
  idFromName(name) { this.requested.push(name); return name; }
  get(id) {
    if (!this.instances.has(id)) this.instances.set(id, new UptimeStorage(makeState(), this.env));
    return this.instances.get(id);
  }
}
const makeEnv = (extra = {}) => {
  const env = { AUTH_TOKEN: 'default-token-value', payment_bot_auth: 'payment-token-value', ...extra };
  env.UPTIME_STORAGE = new FakeNamespace(env);
  return env;
};
const req = (path, init = {}) => new Request(`https://worker.example${path}`, init);
const post = (path, token, body) => req(path, {
  method: 'POST',
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined
});

// ---- routing --------------------------------------------------------------
describe('resolveRoute', () => {
  const cases = [
    ['/api/status', 'default', '/status'],
    ['/api/health', 'default', '/health'],
    ['/api/history', 'default', '/history'],
    ['/heartbeat', 'default', '/heartbeat'],
    ['/api/heartbeat', 'default', '/heartbeat'],
    ['/maintenance/enable', 'default', '/maintenance/enable'],
    ['/api/maintenance/disable', 'default', '/maintenance/disable'],
    ['/payment-bot/status', 'payment-bot', '/status'],
    ['/payment-bot/api/status', 'payment-bot', '/status'],
    ['/payment-bot/api/health', 'payment-bot', '/health'],
    ['/payment-bot/heartbeat', 'payment-bot', '/heartbeat'],
    ['/payment-bot/maintenance/enable', 'payment-bot', '/maintenance/enable'],
    ['/default/heartbeat', 'default', '/heartbeat'],
  ];
  for (const [path, bot, action] of cases) {
    test(`${path} -> ${bot} ${action}`, () => assert.deepEqual(resolveRoute(path), { botName: bot, actionPath: action }));
  }
  for (const path of ['/', '/api', '/payment-bot', '/payment-bot/api', '/payment-bot/unknown', '/api/status/extra', '/x/status/../heartbeat', `/${'a'.repeat(65)}/status`]) {
    test(`${path} is not routable`, () => assert.equal(resolveRoute(path), null));
  }
});

// ---- auth -----------------------------------------------------------------
describe('timingSafeEqual', () => {
  test('equal strings', () => assert.equal(timingSafeEqual('abc', 'abc'), true));
  test('different length', () => assert.equal(timingSafeEqual('abc', 'abcd'), false));
  test('same length different content', () => assert.equal(timingSafeEqual('abc', 'abd'), false));
  test('empty vs non-empty', () => assert.equal(timingSafeEqual('', 'a'), false));
  test('non-strings', () => assert.equal(timingSafeEqual(null, 'a'), false));
});

describe('worker auth', () => {
  test('heartbeat without token -> 401 with CORS header', async () => {
    const res = await worker.fetch(post('/heartbeat', null), makeEnv());
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  });
  test('heartbeat with wrong token -> 401', async () => {
    const res = await worker.fetch(post('/heartbeat', 'wrong'), makeEnv());
    assert.equal(res.status, 401);
  });
  test('prefix of the real token is rejected', async () => {
    const res = await worker.fetch(post('/heartbeat', 'default-token'), makeEnv());
    assert.equal(res.status, 401);
  });
  test('default token does NOT work for a named bot', async () => {
    const res = await worker.fetch(post('/payment-bot/heartbeat', 'default-token-value'), makeEnv());
    assert.equal(res.status, 401);
  });
  test('named bot with no configured secret is rejected even with the default token', async () => {
    const res = await worker.fetch(post('/other-bot/heartbeat', 'default-token-value'), makeEnv());
    assert.equal(res.status, 401);
  });
  test('per-bot secret lookup normalizes the bot name', async () => {
    const env = makeEnv({ my_bot_prod_auth: 'prod-token' });
    const res = await worker.fetch(post('/My-Bot.Prod/heartbeat', 'prod-token'), env);
    assert.equal(res.status, 200);
  });
  test('GET on a protected route -> 405', async () => {
    const res = await worker.fetch(req('/maintenance/enable'), makeEnv());
    assert.equal(res.status, 405);
  });
  test('maintenance toggles require auth on the documented top-level path', async () => {
    const env = makeEnv();
    assert.equal((await worker.fetch(post('/maintenance/enable', null), env)).status, 401);
    assert.equal((await worker.fetch(post('/maintenance/enable', 'default-token-value'), env)).status, 200);
    const health = await (await worker.fetch(req('/api/health'), env)).json();
    assert.equal(health.status, 2);
  });
  test('unknown paths are rejected before any Durable Object is created', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('/some-bot/not-a-route'), env);
    assert.equal(res.status, 404);
    assert.deepEqual(env.UPTIME_STORAGE.requested, []);
  });
  test('OPTIONS preflight is answered with CORS headers', async () => {
    const res = await worker.fetch(req('/api/status', { method: 'OPTIONS' }), makeEnv());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  });
});

// ---- end-to-end behaviour through the worker -------------------------------
describe('heartbeat / status / history flow', () => {
  test('heartbeat is recorded and visible on status, health and history (default and named paths)', async () => {
    const env = makeEnv();
    assert.equal((await worker.fetch(post('/heartbeat', 'default-token-value', { ping: 82.4 }), env)).status, 200);
    const status = await (await worker.fetch(req('/api/status'), env)).json();
    assert.equal(status.status, 1);
    assert.equal(status.heartbeatList[0].ping, 82);
    assert.equal((await worker.fetch(req('/api/health'), env)).status, 200);

    const history = await (await worker.fetch(req('/api/history?limit=5'), env)).json();
    assert.equal(history.limit, 5);
    assert.equal(history.count, 1);
    assert.equal(history.items.length, 1);

    // named bot on both documented path shapes
    assert.equal((await worker.fetch(post('/payment-bot/heartbeat', 'payment-token-value', { ping: 10 }), env)).status, 200);
    assert.equal((await (await worker.fetch(req('/payment-bot/api/status'), env)).json()).status, 1);
    assert.equal((await (await worker.fetch(req('/payment-bot/status'), env)).json()).status, 1);
    // isolation: default bot's data is not the named bot's
    assert.equal((await (await worker.fetch(req('/payment-bot/api/history'), env)).json()).total, 1);
  });

  test('history limit: default 100, clamped to 1..1000, garbage falls back to default', async () => {
    const env = makeEnv();
    for (let i = 0; i < 3; i++) await worker.fetch(post('/heartbeat', 'default-token-value', { ping: i }), env);
    const dflt = await (await worker.fetch(req('/api/history'), env)).json();
    assert.equal(dflt.limit, 100); assert.equal(dflt.count, 3);
    assert.equal((await (await worker.fetch(req('/api/history?limit=0'), env)).json()).limit, 1);
    assert.equal((await (await worker.fetch(req('/api/history?limit=99999'), env)).json()).limit, 1000);
    assert.equal((await (await worker.fetch(req('/api/history?limit=abc'), env)).json()).limit, 100);
    assert.equal((await (await worker.fetch(req('/api/history?limit=2'), env)).json()).count, 2);
  });

  test('malformed heartbeat bodies never crash and never store a non-numeric ping', async () => {
    const env = makeEnv();
    const bodies = ['null', '[]', '42', '"str"', '{"ping":"abc"}', '{"ping":{"x":1}}', '{"ping":null}', '{not json'];
    for (const raw of bodies) {
      const res = await worker.fetch(req('/heartbeat', { method: 'POST', headers: { Authorization: 'Bearer default-token-value', 'Content-Type': 'application/json' }, body: raw }), env);
      assert.equal(res.status, 200, `body ${raw}`);
    }
    const history = await (await worker.fetch(req('/api/history'), env)).json();
    for (const item of history.items) assert.equal(item.ping, undefined);
  });

  test('offline detection: alarm inserts a marker, status shows offline, health is 503', async () => {
    const env = makeEnv();
    await worker.fetch(post('/heartbeat', 'default-token-value'), env);
    const doInstance = env.UPTIME_STORAGE.get('default');
    // age the heartbeat past tolerance
    doInstance.lastHeartbeat.time = new Date(Date.now() - 200_000).toISOString();
    doInstance.heartbeats[0].time = doInstance.lastHeartbeat.time;
    await doInstance.alarm();
    assert.equal(doInstance.heartbeats[0].status, 0);
    assert.equal(doInstance.heartbeats[0].insertionMode, 'alarm');
    assert.equal((await worker.fetch(req('/api/health'), env)).status, 503);
    // status does not insert a second (fallback) marker for the same stale heartbeat
    const status = await (await worker.fetch(req('/api/status'), env)).json();
    assert.equal(status.status, 0);
    assert.equal(status.heartbeatList.filter(h => h.status === 0).length, 1);
  });

  test('fallback marker is inserted on read when the alarm never fired', async () => {
    const env = makeEnv();
    await worker.fetch(post('/heartbeat', 'default-token-value'), env);
    const doInstance = env.UPTIME_STORAGE.get('default');
    doInstance.lastHeartbeat.time = new Date(Date.now() - 200_000).toISOString();
    const status = await (await worker.fetch(req('/api/status'), env)).json();
    assert.equal(status.status, 0);
    assert.equal(status.heartbeatList[0].insertionMode, 'fallback');
  });

  test('state survives a cold start (initializeState is awaited before handling)', async () => {
    const state = makeState();
    const env = makeEnv();
    const first = new UptimeStorage(state, env);
    await first.fetch(req('/heartbeat', { method: 'POST' }));
    const second = new UptimeStorage(state, env); // same storage, fresh instance, no await on construction
    const status = await (await second.fetch(req('/status'))).json();
    assert.equal(status.status, 1);
    assert.equal(status.heartbeatList.length, 1);
  });
});
