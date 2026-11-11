import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.ts';

describe('admin console', () => {
  it('lists users with their workspace memberships', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/admin/users', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().items.length >= 5);
    assert.ok('roles' in res.json().items[0]);
  });

  it('lists workspaces with counters', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/admin/tenants', headers });
    assert.equal(res.statusCode, 200);
    const items = res.json().items;
    assert.ok(items.length >= 2);
    assert.ok('members' in items[0]);
  });

  it('reads and writes workspace settings', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const read = await harness.app.inject({ method: 'GET', url: '/admin/settings', headers });
    assert.equal(read.statusCode, 200);
    assert.ok(read.json().settings.length >= 2);

    const write = await harness.app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers,
      payload: { key: 'theme', value: 'dark' },
    });
    assert.equal(write.statusCode, 200);

    const after = await harness.app.inject({ method: 'GET', url: '/admin/settings', headers });
    const theme = after.json().settings.find((s: any) => s.key === 'theme');
    assert.equal(theme.value, 'dark');
  });

  it('shows the audit trail', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    await harness.app.inject({ method: 'POST', url: '/projects', headers, payload: { name: 'Audited' } });
    const res = await harness.app.inject({ method: 'GET', url: '/admin/audit-logs?limit=20', headers });
    assert.equal(res.statusCode, 200);
    const actions = res.json().items.map((r: any) => r.action);
    assert.ok(actions.includes('project.create'));
  });

  it('suspends an account', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const invited = await harness.app.inject({
      method: 'POST',
      url: '/members',
      headers,
      payload: { email: 'temp@acme.test', name: 'Temp User', role: 'member' },
    });
    const userId = invited.json().userId;
    const res = await harness.app.inject({
      method: 'POST',
      url: '/admin/users/' + userId + '/suspend',
      headers,
      payload: { reason: 'left the company' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'suspended');
  });

  it('404s an unknown account', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'DELETE', url: '/admin/users/u_missing', headers });
    assert.equal(res.statusCode, 404);
  });
});

describe('service meta', () => {
  it('reports health, version, regions and status', async () => {
    const harness = await makeHarness();
    assert.equal((await harness.app.inject({ method: 'GET', url: '/health' })).json().status, 'ok');
    assert.match((await harness.app.inject({ method: 'GET', url: '/meta/version' })).json().version, /^\d+\.\d+\.\d+$/);
    assert.equal((await harness.app.inject({ method: 'GET', url: '/meta/regions' })).json().items.length, 3);
    const status = await harness.app.inject({ method: 'GET', url: '/meta/status' });
    assert.equal(status.json().tenants, 2);
  });
});
