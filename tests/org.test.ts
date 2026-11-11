import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.ts';

describe('org · tenants', () => {
  it('lists the workspaces the caller belongs to', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/tenants', headers });
    assert.equal(res.statusCode, 200);
    const ids = res.json().items.map((t: any) => t.id);
    assert.ok(ids.includes(harness.data.tenants.id));
  });

  it('reads a workspace by id', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/tenants/' + harness.data.tenants.id, headers });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().name, 'Acme Robotics');
  });

  it('updates workspace metadata as owner', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/tenants/' + harness.data.tenants.id,
      headers,
      payload: { name: 'Acme Robotics Inc' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().name, 'Acme Robotics Inc');
  });

  it('refuses workspace updates from a viewer', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('carol@acme.test');
    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/tenants/' + harness.data.tenants.id,
      headers,
      payload: { name: 'Nope' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns workspace stats', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/tenants/' + harness.data.tenants.id + '/stats', headers });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.projects >= 2);
    assert.ok(body.tasks >= 5);
    assert.equal(typeof body.completionRate, 'number');
  });

  it('returns the member directory of a workspace', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/tenants/' + harness.data.tenants.id + '/members', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().items.length >= 3);
  });
});

describe('org · users', () => {
  it('filters users by query string', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/users?q=alice', headers });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().items[0].email, 'alice@acme.test');
  });

  it('reads a colleague profile', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const bob = harness.data.users['bob@acme.test'];
    const res = await harness.app.inject({ method: 'GET', url: '/users/' + bob.id, headers });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().name, 'Bob Li');
  });

  it('renames a colleague', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const bob = harness.data.users['bob@acme.test'];
    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/users/' + bob.id,
      headers,
      payload: { name: 'Bob Li Jr' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().name, 'Bob Li Jr');
  });

  it('returns a profile with team memberships', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const bob = harness.data.users['bob@acme.test'];
    const res = await harness.app.inject({ method: 'GET', url: '/users/' + bob.id + '/profile', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().teams.length >= 1);
  });

  it('derives avatar initials', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const bob = harness.data.users['bob@acme.test'];
    const res = await harness.app.inject({ method: 'GET', url: '/users/' + bob.id + '/avatar', headers });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().initials, 'BL');
  });

  it('404s an unknown user', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/users/u_missing', headers });
    assert.equal(res.statusCode, 404);
  });
});

describe('org · members', () => {
  it('lists members of the current workspace', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/members', headers });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().items.length, 3);
  });

  it('invites a new member and promotes them', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/members',
      headers,
      payload: { email: 'frank@acme.test', name: 'Frank Qi', role: 'member' },
    });
    assert.equal(created.statusCode, 201);
    const membershipId = created.json().id;

    const promoted = await harness.app.inject({
      method: 'PATCH',
      url: '/members/' + membershipId,
      headers,
      payload: { role: 'admin' },
    });
    assert.equal(promoted.statusCode, 200);
    assert.equal(promoted.json().role, 'admin');
  });

  it('rejects inviting an existing member', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/members',
      headers,
      payload: { email: 'bob@acme.test', role: 'member' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('removes a member', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/members',
      headers,
      payload: { email: 'gina@acme.test', name: 'Gina Ye', role: 'viewer' },
    });
    const removed = await harness.app.inject({
      method: 'DELETE',
      url: '/members/' + created.json().id,
      headers,
    });
    assert.equal(removed.statusCode, 200);
  });

  it('refuses member management from a member role', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/members',
      headers,
      payload: { email: 'hans@acme.test' },
    });
    assert.equal(res.statusCode, 403);
  });
});
