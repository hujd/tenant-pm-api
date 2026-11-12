/**
 * Authentication-layer tests: unauthenticated access is uniformly rejected
 * across every protected route group, and disabled memberships lose access.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.ts';

const PROTECTED_GETS = [
  '/projects',
  '/tasks',
  '/comments',
  '/attachments/at_does_not_exist',
  '/tenants',
  '/users',
  '/members',
  '/exports',
  '/search?q=anything',
  '/reports/overview',
  '/webhooks',
  '/admin/users',
  '/auth/me',
];

const PROTECTED_WRITES: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown }> = [
  { method: 'POST', url: '/projects', payload: { name: 'x' } },
  { method: 'POST', url: '/tasks', payload: { projectId: 'x', title: 'x' } },
  { method: 'POST', url: '/tasks/batch-update', payload: { items: [] } },
  { method: 'POST', url: '/tasks/batch-delete', payload: { ids: [] } },
  { method: 'POST', url: '/attachments', payload: { taskId: 'x', filename: 'x' } },
  { method: 'POST', url: '/members', payload: { email: 'x@x.test' } },
  { method: 'POST', url: '/exports', payload: {} },
  { method: 'POST', url: '/webhooks', payload: { url: 'https://x.test' } },
  { method: 'PATCH', url: '/tenants/tn_x', payload: {} },
  { method: 'DELETE', url: '/members/mb_x' },
];

describe('security · authentication', () => {
  it('rejects every protected GET with 401 when no token is presented', async () => {
    const h = await makeHarness();
    for (const url of PROTECTED_GETS) {
      const res = await h.app.inject({ method: 'GET', url } as any);
      assert.equal(res.statusCode, 401, url);
    }
  });

  it('rejects every protected mutation with 401 when no token is presented', async () => {
    const h = await makeHarness();
    for (const call of PROTECTED_WRITES) {
      const res = await h.app.inject(call as any);
      assert.equal(res.statusCode, 401, `${call.method} ${call.url}`);
    }
  });

  it('rejects garbage and unknown bearer tokens', async () => {
    const h = await makeHarness();
    for (const authorization of ['Bearer nope', 'Bearer sess_unknown', 'Basic abc']) {
      const res = await h.app.inject({ method: 'GET', url: '/projects', headers: { authorization } } as any);
      assert.equal(res.statusCode, 401, authorization);
    }
  });

  it('expired sessions are rejected', async () => {
    const h = await makeHarness();
    const token = await h.login('alice@acme.test', 'acme-owner-1');
    h.app.db.prepare('update sessions set expires_at = ? where token = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      token,
    );
    const res = await h.app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 401);
  });

  it('a membership removed through DELETE /members immediately invalidates the session', async () => {
    const h = await makeHarness();
    const admin = await h.auth('alice@acme.test');
    const carolMembership = (
      h.app.db
        .prepare('select m.id from memberships m join users u on u.id = m.user_id where u.email = ?')
        .get('carol@acme.test') as any
    ).id;
    const carol = await h.auth('carol@acme.test');
    assert.equal((await h.app.inject({ method: 'GET', url: '/auth/me', headers: carol })).statusCode, 200);

    const removed = await h.app.inject({ method: 'DELETE', url: '/members/' + carolMembership, headers: admin });
    assert.equal(removed.statusCode, 200);
    const after = await h.app.inject({ method: 'GET', url: '/projects', headers: carol });
    assert.equal(after.statusCode, 401);
  });

  it('login refuses to open a session for a disabled membership', async () => {
    const h = await makeHarness();
    const admin = await h.auth('alice@acme.test');
    const bobId = h.data.users['bob@acme.test'].id;
    await h.app.inject({ method: 'POST', url: '/admin/users/' + bobId + '/suspend', headers: admin, payload: {} });
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'bob@acme.test', password: 'acme-member-1' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('public service endpoints stay reachable without a session', async () => {
    const h = await makeHarness();
    assert.equal((await h.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.equal((await h.app.inject({ method: 'GET', url: '/meta/version' })).statusCode, 200);
    assert.equal((await h.app.inject({ method: 'GET', url: '/meta/regions' })).statusCode, 200);
    assert.equal((await h.app.inject({ method: 'GET', url: '/meta/status' })).statusCode, 200);
  });
});
