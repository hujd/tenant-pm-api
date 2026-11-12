/**
 * Tenant-isolation & RBAC integration tests for org routes:
 * tenants, user directory/profiles and membership administration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers.ts';

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

describe('security · tenant routes', () => {
  it('GET /tenants only returns workspaces the caller belongs to', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({ method: 'GET', url: '/tenants', headers: await h.auth('dave@globex.test') });
    assert.equal(res.statusCode, 200);
    const ids = res.json().items.map((t: any) => t.id);
    assert.deepEqual(ids, [h.data.tenants.globexId]);
  });

  it('GET /tenants/:id, /stats, /members: own 200, cross-tenant 404', async () => {
    const h = await makeHarness();
    const acme = h.data.tenants.id;
    const globex = h.data.tenants.globexId;
    for (const suffix of ['', '/stats', '/members']) {
      const own = await h.app.inject({
        method: 'GET',
        url: '/tenants/' + acme + suffix,
        headers: await h.auth('alice@acme.test'),
      });
      assert.equal(own.statusCode, 200, suffix);
      await denied(h, {
        method: 'GET',
        url: '/tenants/' + acme + suffix,
        headers: await h.auth('dave@globex.test'),
      });
    }
    // sanity: globex owner can still read their own tenant
    assert.equal(
      (await h.app.inject({ method: 'GET', url: '/tenants/' + globex, headers: await h.auth('dave@globex.test') }))
        .statusCode,
      200,
    );
  });

  it('PATCH /tenants/:id: owner 200, cross-tenant owner 404, viewer 403', async () => {
    const h = await makeHarness();
    const url = '/tenants/' + h.data.tenants.id;
    assert.equal(
      (await h.app.inject({ method: 'PATCH', url, headers: await h.auth('alice@acme.test'), payload: { name: 'Acme' } }))
        .statusCode,
      200,
    );
    await denied(h, {
      method: 'PATCH',
      url: '/tenants/' + h.data.tenants.id,
      headers: await h.auth('dave@globex.test'),
      payload: { name: 'pwn' },
    });
    assert.equal(
      (await h.app.inject({ method: 'PATCH', url, headers: await h.auth('carol@acme.test'), payload: { name: 'pwn' } }))
        .statusCode,
      403,
    );
  });
});

describe('security · user directory', () => {
  it('GET /users and /search/users only expose co-members of the same tenant', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({ method: 'GET', url: '/users', headers: await h.auth('alice@acme.test') });
    assert.equal(res.statusCode, 200);
    const emails = res.json().items.map((u: any) => u.email).sort();
    assert.deepEqual(emails, ['alice@acme.test', 'bob@acme.test', 'carol@acme.test']);

    const search = await h.app.inject({
      method: 'GET',
      url: '/search/users?q=erin',
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(search.statusCode, 200);
    assert.equal(search.json().items.length, 0);
  });

  it('GET /users/:id, /profile, /avatar: colleague 200, foreign-tenant user 404', async () => {
    const h = await makeHarness();
    const bob = h.data.users['bob@acme.test'].id;
    const erin = h.data.users['erin@globex.test'].id;
    for (const suffix of ['', '/profile', '/avatar']) {
      assert.equal(
        (await h.app.inject({ method: 'GET', url: '/users/' + bob + suffix, headers: await h.auth('alice@acme.test') }))
          .statusCode,
        200,
      );
      await denied(h, {
        method: 'GET',
        url: '/users/' + erin + suffix,
        headers: await h.auth('alice@acme.test'),
      });
    }
    // profile must not leak the user's other workspace memberships
    const profile = await h.app.inject({
      method: 'GET',
      url: '/users/' + bob + '/profile',
      headers: await h.auth('alice@acme.test'),
    });
    for (const team of profile.json().teams) assert.equal(team.tenant_id, h.data.tenants.id);
  });

  it('PATCH /users/:id: self and admin allowed, other-tenant 404, non-admin colleague 403', async () => {
    const h = await makeHarness();
    const bob = h.data.users['bob@acme.test'].id;
    const erin = h.data.users['erin@globex.test'].id;

    const self = await h.app.inject({
      method: 'PATCH',
      url: '/users/' + bob,
      headers: await h.auth('bob@acme.test'),
      payload: { name: 'Bob Renamed' },
    });
    assert.equal(self.statusCode, 200);

    const adminEdit = await h.app.inject({
      method: 'PATCH',
      url: '/users/' + bob,
      headers: await h.auth('alice@acme.test'),
      payload: { name: 'Bob By Admin' },
    });
    assert.equal(adminEdit.statusCode, 200);

    const peerEdit = await h.app.inject({
      method: 'PATCH',
      url: '/users/' + h.data.users['carol@acme.test'].id,
      headers: await h.auth('bob@acme.test'),
      payload: { name: 'nope' },
    });
    assert.equal(peerEdit.statusCode, 403);

    await denied(h, {
      method: 'PATCH',
      url: '/users/' + erin,
      headers: await h.auth('alice@acme.test'),
      payload: { name: 'pwn' },
    });
  });

  it('DELETE /users/:id: admin only, scoped to the tenant, member gets 403', async () => {
    const h = await makeHarness();
    const carol = h.data.users['carol@acme.test'].id;
    const erin = h.data.users['erin@globex.test'].id;

    const member = await h.app.inject({
      method: 'DELETE',
      url: '/users/' + carol,
      headers: await h.auth('bob@acme.test'),
    });
    assert.equal(member.statusCode, 403);

    const cross = await h.app.inject({
      method: 'DELETE',
      url: '/users/' + erin,
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(cross.statusCode, 404);
    // erin's globex membership must be intact
    const stillMember = h.app.db
      .prepare("select status from memberships where tenant_id = ? and user_id = ?")
      .get(h.data.tenants.globexId, erin) as any;
    assert.equal(stillMember.status, 'active');

    const ok = await h.app.inject({
      method: 'DELETE',
      url: '/users/' + carol,
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(ok.statusCode, 200);
  });
});

describe('security · membership administration', () => {
  it('GET /members refuses a foreign tenantId query', async () => {
    const h = await makeHarness();
    const ok = await h.app.inject({ method: 'GET', url: '/members', headers: await h.auth('alice@acme.test') });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().items.length, 3);
    await denied(h, {
      method: 'GET',
      url: '/members?tenantId=' + h.data.tenants.globexId,
      headers: await h.auth('alice@acme.test'),
    });
  });

  it('POST /members: admin 201, member 403, foreign tenantId in body 403', async () => {
    const h = await makeHarness();
    const ok = await h.app.inject({
      method: 'POST',
      url: '/members',
      headers: await h.auth('alice@acme.test'),
      payload: { email: 'newbie@acme.test', name: 'Newbie', role: 'member' },
    });
    assert.equal(ok.statusCode, 201);

    const lowRole = await h.app.inject({
      method: 'POST',
      url: '/members',
      headers: await h.auth('bob@acme.test'),
      payload: { email: 'x@acme.test' },
    });
    assert.equal(lowRole.statusCode, 403);

    const crossBody = await h.app.inject({
      method: 'POST',
      url: '/members',
      headers: await h.auth('alice@acme.test'),
      payload: { email: 'intruder@globex.test', tenantId: h.data.tenants.globexId },
    });
    assert.equal(crossBody.statusCode, 403);
    const noMembership = h.app.db
      .prepare('select 1 from memberships where tenant_id = ? and user_id in (select id from users where email = ?)')
      .get(h.data.tenants.globexId, 'intruder@globex.test');
    assert.equal(noMembership, undefined);
  });

  it('PATCH/DELETE /members/:id: admin 200 on own membership, cross-tenant membership id 404, member 403', async () => {
    const h = await makeHarness();
    const acmeMembership = h.app.db
      .prepare('select id from memberships where tenant_id = ?')
      .all(h.data.tenants.id)
      .map((r: any) => r.id);
    const globexMembership = (
      h.app.db.prepare('select id from memberships where tenant_id = ?').get(h.data.tenants.globexId) as any
    ).id;

    const patch = await h.app.inject({
      method: 'PATCH',
      url: '/members/' + acmeMembership[0],
      headers: await h.auth('alice@acme.test'),
      payload: { role: 'admin' },
    });
    assert.equal(patch.statusCode, 200);

    await denied(h, {
      method: 'PATCH',
      url: '/members/' + globexMembership,
      headers: await h.auth('alice@acme.test'),
      payload: { role: 'owner' },
    });
    await denied(h, {
      method: 'DELETE',
      url: '/members/' + globexMembership,
      headers: await h.auth('alice@acme.test'),
    });
    const stillThere = h.app.db.prepare('select 1 from memberships where id = ?').get(globexMembership);
    assert.ok(stillThere);

    const lowRole = await h.app.inject({
      method: 'DELETE',
      url: '/members/' + acmeMembership[1],
      headers: await h.auth('bob@acme.test'),
    });
    assert.equal(lowRole.statusCode, 403);
  });
});
