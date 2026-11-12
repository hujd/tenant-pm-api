/**
 * Tenant-isolation & RBAC integration tests for insight routes
 * (exports, search, reports, webhooks) and the admin console, including the
 * x-role header spoofing privilege-escalation regression.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers.ts';
import { cacheClear } from '../src/cache.ts';

const DENIED = new Set([403, 404]);

type InjectOpts = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
};

async function denied(h: Harness, opts: InjectOpts) {
  const res = await h.app.inject(opts as any);
  assert.ok(
    DENIED.has(res.statusCode),
    `expected 403/404 for ${opts.method} ${opts.url}, got ${res.statusCode}: ${res.body}`,
  );
  return res;
}

describe('security · exports (incl. download)', () => {
  it('GET /exports and /exports/:id: own job visible, foreign job 404', async () => {
    const h = await makeHarness();
    const list = await h.app.inject({ method: 'GET', url: '/exports', headers: await h.auth('alice@acme.test') });
    assert.equal(list.statusCode, 200);
    for (const job of list.json().items) assert.equal(job.tenant_id, h.data.tenants.id);

    const own = await h.app.inject({
      method: 'GET',
      url: '/exports/' + h.data.exportJobs.acme,
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(own.statusCode, 200);
    await denied(h, {
      method: 'GET',
      url: '/exports/' + h.data.exportJobs.acme,
      headers: await h.auth('dave@globex.test'),
    });
  });

  it('GET /exports/:id/download: cross-tenant 404 and no foreign rows returned', async () => {
    const h = await makeHarness();
    const ok = await h.app.inject({
      method: 'GET',
      url: '/exports/' + h.data.exportJobs.acme + '/download',
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(ok.statusCode, 200);
    for (const row of ok.json().rows) assert.equal(row.tenant_id, h.data.tenants.id);

    const cross = await h.app.inject({
      method: 'GET',
      url: '/exports/' + h.data.exportJobs.globex + '/download',
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(cross.statusCode, 404);
    assert.equal(cross.json().rows, undefined);
  });

  it('POST /exports ignores a forged filters.tenantId and pins the session tenant', async () => {
    const h = await makeHarness();
    const forged = await h.app.inject({
      method: 'POST',
      url: '/exports',
      headers: await h.auth('alice@acme.test'),
      payload: { kind: 'tasks', filters: { tenantId: h.data.tenants.globexId } },
    });
    assert.equal(forged.statusCode, 201);
    const stored = JSON.parse(forged.json().filters);
    assert.equal(stored.tenantId, h.data.tenants.id);

    const download = await h.app.inject({
      method: 'GET',
      url: '/exports/' + forged.json().id + '/download',
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(download.statusCode, 200);
    assert.ok(download.json().rowCount >= 1);
    for (const row of download.json().rows) assert.equal(row.tenant_id, h.data.tenants.id);
  });

  it('POST /exports rejects a foreign projectId filter', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/exports',
      headers: await h.auth('alice@acme.test'),
      payload: { kind: 'tasks', filters: { projectId: h.data.projects.globexLake } },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('security · search', () => {
  it('/search and its sub-routes never return another tenant’s rows', async () => {
    const h = await makeHarness();
    // "Kafka" only exists in Globex's task titles.
    const res = await h.app.inject({ method: 'GET', url: '/search?q=Kafka', headers: await h.auth('alice@acme.test') });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().tasks.length, 0);
    assert.equal(res.json().projects.length, 0);
    assert.equal(res.json().comments.length, 0);

    const globex = await h.app.inject({
      method: 'GET',
      url: '/search?q=Kafka',
      headers: await h.auth('dave@globex.test'),
    });
    assert.ok(globex.json().tasks.length >= 1);

    for (const path of ['/search/tasks?q=Kafka', '/search/projects?q=Data', '/search/users?q=erin']) {
      const cross = await h.app.inject({ method: 'GET', url: path, headers: await h.auth('alice@acme.test') });
      assert.equal(cross.statusCode, 200);
      assert.equal(cross.json().items.length, 0, path);
    }
  });
});

describe('security · reports', () => {
  beforeEach(() => cacheClear());

  it('overview/tasks-by-status/activity/utilization/export are tenant-scoped', async () => {
    const h = await makeHarness();
    const headers = await h.auth('alice@acme.test');

    const overview = await h.app.inject({ method: 'GET', url: '/reports/overview', headers });
    assert.equal(overview.statusCode, 200);
    // Acme seed has 5 tasks, Globex has 2 — a global count would be 7.
    assert.equal(overview.json().tasks, 5);

    const activity = await h.app.inject({ method: 'GET', url: '/reports/activity?limit=50', headers });
    for (const row of activity.json().items) assert.equal(row.tenant_id, h.data.tenants.id);

    const utilization = await h.app.inject({ method: 'GET', url: '/reports/utilization', headers });
    const names = utilization.json().items.map((u: any) => u.name);
    assert.ok(!names.includes('Erin Sun'));
    assert.ok(names.includes('Bob Li'));

    const csv = await h.app.inject({ method: 'GET', url: '/reports/export?format=csv&kind=tasks', headers });
    assert.equal(csv.statusCode, 200);
    const body = String(csv.body);
    assert.ok(!body.includes(h.data.tasks.globexIngest));
    assert.ok(body.includes(h.data.tasks.acmeWebHero));
  });

  it('cached overview does not leak across tenants', async () => {
    const h = await makeHarness();
    await h.app.inject({ method: 'GET', url: '/reports/overview', headers: await h.auth('alice@acme.test') });
    const globex = await h.app.inject({
      method: 'GET',
      url: '/reports/overview',
      headers: await h.auth('dave@globex.test'),
    });
    assert.equal(globex.json().tasks, 2); // not Acme's cached 5
  });
});

describe('security · webhooks', () => {
  it('lists own webhooks only; foreign webhook delete 404; viewer cannot create/delete', async () => {
    const h = await makeHarness();
    const list = await h.app.inject({ method: 'GET', url: '/webhooks', headers: await h.auth('alice@acme.test') });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 1);
    assert.equal(list.json().items[0].id, h.data.webhooks.acme);

    await denied(h, {
      method: 'DELETE',
      url: '/webhooks/' + h.data.webhooks.globex,
      headers: await h.auth('alice@acme.test'),
    });

    const viewerCreate = await h.app.inject({
      method: 'POST',
      url: '/webhooks',
      headers: await h.auth('carol@acme.test'),
      payload: { url: 'https://evil.example/hook' },
    });
    assert.equal(viewerCreate.statusCode, 403);

    const ok = await h.app.inject({
      method: 'POST',
      url: '/webhooks',
      headers: await h.auth('alice@acme.test'),
      payload: { url: 'https://hooks.acme.test/new' },
    });
    assert.equal(ok.statusCode, 201);
    const del = await h.app.inject({
      method: 'DELETE',
      url: '/webhooks/' + ok.json().id,
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(del.statusCode, 200);
  });
});

describe('security · admin console', () => {
  it('privilege escalation via x-role header is impossible', async () => {
    const h = await makeHarness();
    // Carol is a viewer. The old adminGate trusted this client header.
    const spoofed = { authorization: (await h.auth('carol@acme.test')).authorization, 'x-role': 'owner' };
    for (const url of ['/admin/users', '/admin/tenants', '/admin/audit-logs', '/admin/settings']) {
      const res = await h.app.inject({ method: 'GET', url, headers: spoofed });
      assert.equal(res.statusCode, 403, url);
    }
    const suspend = await h.app.inject({
      method: 'POST',
      url: '/admin/users/' + h.data.users['bob@acme.test'].id + '/suspend',
      headers: spoofed,
      payload: {},
    });
    assert.equal(suspend.statusCode, 403);
  });

  it('ordinary member role is rejected even with a real bearer token', async () => {
    const h = await makeHarness();
    const headers = await h.auth('bob@acme.test'); // member, no admin rights
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin/users', headers })).statusCode, 403);
    assert.equal(
      (await h.app.inject({ method: 'GET', url: '/admin/audit-logs', headers })).statusCode,
      403,
    );
  });

  it('admin endpoints stay usable for a genuine tenant admin (happy path)', async () => {
    const h = await makeHarness();
    const headers = await h.auth('alice@acme.test');
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin/users', headers })).statusCode, 200);
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin/tenants', headers })).statusCode, 200);
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin/audit-logs', headers })).statusCode, 200);
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin/settings', headers })).statusCode, 200);
  });

  it('admin actions cannot reach the other tenant', async () => {
    const h = await makeHarness();
    const headers = await h.auth('alice@acme.test');

    const foreignUser = await h.app.inject({
      method: 'POST',
      url: '/admin/users/' + h.data.users['erin@globex.test'].id + '/suspend',
      headers,
      payload: {},
    });
    assert.equal(foreignUser.statusCode, 404);
    const untouched = h.app.db
      .prepare('select status from memberships where tenant_id = ? and user_id = ?')
      .get(h.data.tenants.globexId, h.data.users['erin@globex.test'].id) as any;
    assert.equal(untouched.status, 'active');

    await denied(h, { method: 'GET', url: '/admin/audit-logs?tenantId=' + h.data.tenants.globexId, headers });
    await denied(h, { method: 'GET', url: '/admin/settings?tenantId=' + h.data.tenants.globexId, headers });

    const writeForeign = await h.app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers,
      payload: { key: 'theme', value: 'dark', tenantId: h.data.tenants.globexId },
    });
    assert.equal(writeForeign.statusCode, 403);
    const globexSetting = h.app.db
      .prepare('select value from settings where tenant_id = ? and key = ?')
      .get(h.data.tenants.globexId, 'theme') as any;
    assert.equal(globexSetting.value, 'light');
  });

  it('admin suspend on own tenant still works and kills the session', async () => {
    const h = await makeHarness();
    const headers = await h.auth('alice@acme.test');
    const bobId = h.data.users['bob@acme.test'].id;
    // Open Bob's session before suspending him.
    const bobHeaders = await h.auth('bob@acme.test');
    assert.equal((await h.app.inject({ method: 'GET', url: '/auth/me', headers: bobHeaders })).statusCode, 200);

    const suspend = await h.app.inject({
      method: 'POST',
      url: '/admin/users/' + bobId + '/suspend',
      headers,
      payload: { reason: 'test' },
    });
    assert.equal(suspend.statusCode, 200);
    // The existing session stops resolving once the membership is suspended.
    const me = await h.app.inject({ method: 'GET', url: '/auth/me', headers: bobHeaders });
    assert.equal(me.statusCode, 401);
    // And no new session can be created.
    const relogin = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'bob@acme.test', password: 'acme-member-1' },
    });
    assert.equal(relogin.statusCode, 403);
  });
});
