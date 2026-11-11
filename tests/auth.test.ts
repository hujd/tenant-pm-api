import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.ts';

describe('auth', () => {
  it('logs in with seeded credentials and returns a token', async () => {
    const { app, data } = await makeHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'alice@acme.test', password: 'acme-owner-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.match(body.token, /^sess_/);
    assert.equal(body.tenantId, data.tenants.id);
    assert.equal(body.role, 'owner');
  });

  it('rejects a wrong password', async () => {
    const { app } = await makeHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'alice@acme.test', password: 'nope' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects a missing body', async () => {
    const { app } = await makeHarness();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    assert.equal(res.statusCode, 400);
  });

  it('returns the current user and workspace from /auth/me', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/auth/me', headers });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.user.email, 'bob@acme.test');
    assert.equal(body.tenant.name, 'Acme Robotics');
    assert.equal(body.role, 'member');
  });

  it('creates a new workspace on register', async () => {
    const { app } = await makeHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'new@acme.test', password: 'secret123', name: 'New Person', tenantName: 'New Co' },
    });
    assert.equal(res.statusCode, 201);
    assert.match(res.json().tenantId, /^tn_/);

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer ' + res.json().token },
    });
    assert.equal(me.json().tenant.name, 'New Co');
    assert.equal(me.json().role, 'owner');
  });

  it('rejects duplicate registration', async () => {
    const { app } = await makeHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'alice@acme.test', password: 'x', name: 'Dup', tenantName: 'Dup Co' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('requires a session for /auth/me and /auth/logout', async () => {
    const { app } = await makeHarness();
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode, 401);
  });

  it('invalidates the session on logout', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('carol@acme.test');
    const out = await harness.app.inject({ method: 'POST', url: '/auth/logout', headers });
    assert.equal(out.statusCode, 200);
    const me = await harness.app.inject({ method: 'GET', url: '/auth/me', headers });
    assert.equal(me.statusCode, 401);
  });
});
