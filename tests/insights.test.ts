import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.ts';

describe('exports', () => {
  it('queues an export and plays it back', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/exports',
      headers,
      payload: { kind: 'tasks', filters: { tenantId: harness.data.tenants.id, status: 'todo' } },
    });
    assert.equal(created.statusCode, 201);
    const jobId = created.json().id;

    const read = await harness.app.inject({ method: 'GET', url: '/exports/' + jobId, headers });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().kind, 'tasks');

    const download = await harness.app.inject({ method: 'GET', url: '/exports/' + jobId + '/download', headers });
    assert.equal(download.statusCode, 200);
    const body = download.json();
    assert.equal(body.kind, 'tasks');
    assert.ok(body.rowCount >= 1);
    for (const row of body.rows) assert.equal(row.status, 'todo');
  });

  it('lists queued exports', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    await harness.app.inject({ method: 'POST', url: '/exports', headers, payload: { kind: 'projects', filters: {} } });
    const res = await harness.app.inject({ method: 'GET', url: '/exports', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().items.length >= 1);
  });

  it('rejects an unsupported export kind', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'POST', url: '/exports', headers, payload: { kind: 'secrets' } });
    assert.equal(res.statusCode, 400);
  });
});

describe('search', () => {
  it('searches across resources', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/search?q=Hero', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().tasks.length >= 1);
  });

  it('searches a single resource type', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    for (const path of ['/search/tasks?q=login', '/search/projects?q=Mobile', '/search/users?q=bob']) {
      const res = await harness.app.inject({ method: 'GET', url: path, headers });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(res.json().items));
    }
  });

  it('rejects a query that is too short', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/search?q=a', headers });
    assert.equal(res.statusCode, 400);
  });
});

describe('reports', () => {
  it('returns the overview counters', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/reports/overview', headers });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.tasks > 0);
    assert.equal(typeof body.completionRate, 'number');
  });

  it('groups tasks by status', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/reports/tasks-by-status', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().items.length >= 2);
  });

  it('lists recent activity', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/reports/activity?limit=10', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json().items));
  });

  it('computes per-user utilization', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/reports/utilization', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().items.length >= 3);
  });

  it('exports a report as csv', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/reports/export?format=csv&kind=tasks', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers['content-type']).includes('text/csv'));
    assert.ok(res.body.split('\n').length > 1);
  });
});

describe('webhooks', () => {
  it('registers, lists and removes a webhook', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/webhooks',
      headers,
      payload: { url: 'https://hooks.acme.test/projects', event: 'project.updated' },
    });
    assert.equal(created.statusCode, 201);

    const list = await harness.app.inject({ method: 'GET', url: '/webhooks', headers });
    assert.ok(list.json().items.length >= 2);

    const removed = await harness.app.inject({ method: 'DELETE', url: '/webhooks/' + created.json().id, headers });
    assert.equal(removed.statusCode, 200);
  });

  it('rejects a non-http webhook url', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'POST', url: '/webhooks', headers, payload: { url: 'ftp://x' } });
    assert.equal(res.statusCode, 400);
  });
});
