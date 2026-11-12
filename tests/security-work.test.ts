/**
 * Tenant-isolation & RBAC integration tests for the work resources.
 *
 * For every endpoint the suite proves two things with real two-tenant fixture
 * data:
 *   1. the owner of the resource (Acme) gets the documented success response;
 *   2. a member of the other tenant (Globex) is rejected with 403/404 and
 *      the foreign row is untouched.
 * Low-privilege checks additionally prove viewers cannot mutate.
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

describe('security · projects', () => {
  beforeEach(() => cacheClear());

  it('GET /projects: lists own tenant, hides the other tenant', async () => {
    const h = await makeHarness();
    const own = await h.app.inject({ method: 'GET', url: '/projects', headers: await h.auth('alice@acme.test') });
    assert.equal(own.statusCode, 200);
    assert.ok(own.json().items.length >= 2);
    for (const p of own.json().items) assert.equal(p.tenant_id, h.data.tenants.id);

    const other = await h.app.inject({ method: 'GET', url: '/projects', headers: await h.auth('dave@globex.test') });
    const ids = other.json().items.map((p: any) => p.id);
    assert.ok(!ids.includes(h.data.projects.acmeWeb));
    assert.ok(ids.includes(h.data.projects.globexLake));
  });

  it('GET /projects/:id: own 200, cross-tenant 404', async () => {
    const h = await makeHarness();
    const ok = await h.app.inject({
      method: 'GET',
      url: '/projects/' + h.data.projects.acmeWeb,
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(ok.statusCode, 200);
    await denied(h, {
      method: 'GET',
      url: '/projects/' + h.data.projects.acmeWeb,
      headers: await h.auth('dave@globex.test'),
    });
  });

  it('PATCH /projects/:id: own 200, cross-tenant 404, viewer 403', async () => {
    const h = await makeHarness();
    const url = '/projects/' + h.data.projects.acmeWeb;
    const ok = await h.app.inject({
      method: 'PATCH',
      url,
      headers: await h.auth('bob@acme.test'),
      payload: { name: 'Website Revamp v2' },
    });
    assert.equal(ok.statusCode, 200);
    await denied(h, { method: 'PATCH', url, headers: await h.auth('dave@globex.test'), payload: { name: 'x' } });
    const viewer = await h.app.inject({
      method: 'PATCH',
      url,
      headers: await h.auth('carol@acme.test'),
      payload: { name: 'x' },
    });
    assert.equal(viewer.statusCode, 403);
  });

  it('DELETE /projects/:id: own 200, cross-tenant 404 and foreign row survives', async () => {
    const h = await makeHarness();
    const url = '/projects/' + h.data.projects.acmeMobile;
    const ok = await h.app.inject({ method: 'DELETE', url, headers: await h.auth('alice@acme.test') });
    assert.equal(ok.statusCode, 200);

    const h2 = await makeHarness();
    await denied(h2, {
      method: 'DELETE',
      url: '/projects/' + h2.data.projects.acmeWeb,
      headers: await h2.auth('dave@globex.test'),
    });
    const stillThere = await h2.app.inject({
      method: 'GET',
      url: '/projects/' + h2.data.projects.acmeWeb,
      headers: await h2.auth('alice@acme.test'),
    });
    assert.equal(stillThere.statusCode, 200);
  });

  it('POST /projects/batch-archive: own ids succeed, one foreign id rejects the whole batch', async () => {
    const h = await makeHarness();
    const ok = await h.app.inject({
      method: 'POST',
      url: '/projects/batch-archive',
      headers: await h.auth('alice@acme.test'),
      payload: { ids: [h.data.projects.acmeWeb, h.data.projects.acmeMobile] },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().archived, 2);

    const mixed = await h.app.inject({
      method: 'POST',
      url: '/projects/batch-archive',
      headers: await h.auth('dave@globex.test'),
      payload: { ids: [h.data.projects.globexLake, h.data.projects.acmeWeb] },
    });
    assert.ok(DENIED.has(mixed.statusCode));
    // Globex's own project must not have been archived either (all-or-nothing).
    const row = h.app.db.prepare('select status from projects where id = ?').get(h.data.projects.globexLake) as any;
    assert.equal(row.status, 'active');
  });

  it('GET /projects/:id/summary and /tasks: own 200, cross-tenant 404', async () => {
    const h = await makeHarness();
    for (const suffix of ['/summary', '/tasks']) {
      const url = '/projects/' + h.data.projects.acmeWeb + suffix;
      assert.equal((await h.app.inject({ method: 'GET', url, headers: await h.auth('alice@acme.test') })).statusCode, 200);
      await denied(h, { method: 'GET', url, headers: await h.auth('dave@globex.test') });
    }
  });
});

describe('security · tasks', () => {
  it('GET /tasks: returns only caller-tenant rows; foreign projectId filter is rejected', async () => {
    const h = await makeHarness();
    const own = await h.app.inject({ method: 'GET', url: '/tasks', headers: await h.auth('alice@acme.test') });
    assert.equal(own.statusCode, 200);
    for (const t of own.json().items) assert.equal(t.tenant_id, h.data.tenants.id);

    const cross = await h.app.inject({
      method: 'GET',
      url: '/tasks?projectId=' + h.data.projects.globexLake,
      headers: await h.auth('alice@acme.test'),
    });
    assert.ok(DENIED.has(cross.statusCode));
  });

  it('POST /tasks: own project 201, foreign project 404, viewer 403', async () => {
    const h = await makeHarness();
    const ok = await h.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: await h.auth('bob@acme.test'),
      payload: { projectId: h.data.projects.acmeWeb, title: 'New task' },
    });
    assert.equal(ok.statusCode, 201);

    const cross = await h.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: await h.auth('dave@globex.test'),
      payload: { projectId: h.data.projects.acmeWeb, title: 'pwn' },
    });
    assert.equal(cross.statusCode, 404);

    const viewer = await h.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: await h.auth('carol@acme.test'),
      payload: { projectId: h.data.projects.acmeWeb, title: 'pwn' },
    });
    assert.equal(viewer.statusCode, 403);
  });

  it('GET/PATCH/DELETE /tasks/:id: own 200, cross-tenant 404', async () => {
    const h = await makeHarness();
    const url = '/tasks/' + h.data.tasks.acmeWebSeo;
    assert.equal((await h.app.inject({ method: 'GET', url, headers: await h.auth('alice@acme.test') })).statusCode, 200);
    assert.equal(
      (await h.app.inject({ method: 'PATCH', url, headers: await h.auth('bob@acme.test'), payload: { status: 'done' } }))
        .statusCode,
      200,
    );

    const h2 = await makeHarness();
    const u2 = '/tasks/' + h2.data.tasks.acmeWebSeo;
    await denied(h2, { method: 'GET', url: u2, headers: await h2.auth('dave@globex.test') });
    await denied(h2, { method: 'PATCH', url: u2, headers: await h2.auth('dave@globex.test'), payload: { status: 'done' } });
    await denied(h2, { method: 'DELETE', url: u2, headers: await h2.auth('dave@globex.test') });
    const stillThere = h2.app.db.prepare('select deleted_at from tasks where id = ?').get(h2.data.tasks.acmeWebSeo) as any;
    assert.equal(stillThere.deleted_at, null);
  });

  it('POST /tasks/batch-update: mixed tenant ids rejected atomically', async () => {
    const h = await makeHarness();
    const ok = await h.app.inject({
      method: 'POST',
      url: '/tasks/batch-update',
      headers: await h.auth('bob@acme.test'),
      payload: { items: [{ id: h.data.tasks.acmeWebSeo, status: 'done' }] },
    });
    assert.equal(ok.statusCode, 200);

    const mixed = await h.app.inject({
      method: 'POST',
      url: '/tasks/batch-update',
      headers: await h.auth('dave@globex.test'),
      payload: {
        items: [
          { id: h.data.tasks.globexIngest, status: 'done' },
          { id: h.data.tasks.acmeWebSeo, status: 'done' },
        ],
      },
    });
    assert.ok(DENIED.has(mixed.statusCode));
    const row = h.app.db.prepare('select status from tasks where id = ?').get(h.data.tasks.globexIngest) as any;
    assert.equal(row.status, 'todo'); // first item in the batch must not be written either
  });

  it('POST /tasks/batch-delete: own ids deleted, foreign ids rejected and preserved', async () => {
    const h = await makeHarness();
    const ok = await h.app.inject({
      method: 'POST',
      url: '/tasks/batch-delete',
      headers: await h.auth('alice@acme.test'),
      payload: { ids: [h.data.tasks.acmeWebSeo] },
    });
    assert.equal(ok.statusCode, 200);

    const h2 = await makeHarness();
    await denied(h2, {
      method: 'POST',
      url: '/tasks/batch-delete',
      headers: await h2.auth('dave@globex.test'),
      payload: { ids: [h2.data.tasks.acmeWebSeo, h2.data.tasks.acmeWebCms] },
    });
    for (const id of [h2.data.tasks.acmeWebSeo, h2.data.tasks.acmeWebCms]) {
      const row = h2.app.db.prepare('select deleted_at from tasks where id = ?').get(id) as any;
      assert.equal(row.deleted_at, null);
    }
  });

  it('task comment routes: own 200/201, cross-tenant 404, viewer cannot post', async () => {
    const h = await makeHarness();
    const url = '/tasks/' + h.data.tasks.acmeWebHero + '/comments';
    const list = await h.app.inject({ method: 'GET', url, headers: await h.auth('carol@acme.test') });
    assert.equal(list.statusCode, 200);
    const post = await h.app.inject({
      method: 'POST',
      url,
      headers: await h.auth('bob@acme.test'),
      payload: { body: 'hello' },
    });
    assert.equal(post.statusCode, 201);

    await denied(h, { method: 'GET', url, headers: await h.auth('dave@globex.test') });
    await denied(h, {
      method: 'POST',
      url,
      headers: await h.auth('dave@globex.test'),
      payload: { body: 'pwn' },
    });
    const viewer = await h.app.inject({
      method: 'POST',
      url,
      headers: await h.auth('carol@acme.test'),
      payload: { body: 'pwn' },
    });
    assert.equal(viewer.statusCode, 403);
  });
});

describe('security · comments', () => {
  it('collection and item: own 200, cross-tenant 404', async () => {
    const h = await makeHarness();
    const list = await h.app.inject({
      method: 'GET',
      url: '/comments?taskId=' + h.data.tasks.acmeWebHero,
      headers: await h.auth('alice@acme.test'),
    });
    assert.equal(list.statusCode, 200);
    const item = '/comments/' + h.data.comments.acmeHero1;
    assert.equal((await h.app.inject({ method: 'GET', url: item, headers: await h.auth('alice@acme.test') })).statusCode, 200);
    await denied(h, { method: 'GET', url: item, headers: await h.auth('dave@globex.test') });
    await denied(h, { method: 'PATCH', url: item, headers: await h.auth('dave@globex.test'), payload: { body: 'x' } });
    await denied(h, { method: 'DELETE', url: item, headers: await h.auth('dave@globex.test') });
  });

  it('PATCH/DELETE a colleague comment: author or admin only, viewer 403', async () => {
    const h = await makeHarness();
    // alice's own comment — she can edit.
    const own = '/comments/' + h.data.comments.acmeHero2;
    assert.equal(
      (await h.app.inject({ method: 'PATCH', url: own, headers: await h.auth('alice@acme.test'), payload: { body: 'b2' } }))
        .statusCode,
      200,
    );
    // bob (member, not author, not admin) cannot edit alice's comment.
    const notAuthor = await h.app.inject({
      method: 'PATCH',
      url: own,
      headers: await h.auth('bob@acme.test'),
      payload: { body: 'b3' },
    });
    assert.equal(notAuthor.statusCode, 403);
    // viewer is below writer role.
    const viewer = await h.app.inject({
      method: 'DELETE',
      url: own,
      headers: await h.auth('carol@acme.test'),
    });
    assert.equal(viewer.statusCode, 403);
  });
});

describe('security · attachments (incl. download)', () => {
  it('metadata and download: own 200, cross-tenant 404 — no foreign storage key leaks', async () => {
    const h = await makeHarness();
    const id = h.data.attachments.acmeHeroPng;
    const read = await h.app.inject({ method: 'GET', url: '/attachments/' + id, headers: await h.auth('alice@acme.test') });
    assert.equal(read.statusCode, 200);
    const dl = await h.app.inject({
      method: 'GET',
      url: '/attachments/' + id + '/download',
      headers: await h.auth('bob@acme.test'),
    });
    assert.equal(dl.statusCode, 200);
    assert.ok(dl.json().url.includes(h.data.tenants.id));

    const crossRead = await h.app.inject({
      method: 'GET',
      url: '/attachments/' + id,
      headers: await h.auth('dave@globex.test'),
    });
    assert.equal(crossRead.statusCode, 404);
    const crossDl = await h.app.inject({
      method: 'GET',
      url: '/attachments/' + id + '/download',
      headers: await h.auth('dave@globex.test'),
    });
    assert.equal(crossDl.statusCode, 404);
    assert.equal(crossDl.json().url, undefined);
  });

  it('POST /attachments rejects a foreign taskId; DELETE is tenant-scoped', async () => {
    const h = await makeHarness();
    const cross = await h.app.inject({
      method: 'POST',
      url: '/attachments',
      headers: await h.auth('dave@globex.test'),
      payload: { taskId: h.data.tasks.acmeWebHero, filename: 'x.png' },
    });
    assert.equal(cross.statusCode, 404);

    const ok = await h.app.inject({
      method: 'POST',
      url: '/attachments',
      headers: await h.auth('bob@acme.test'),
      payload: { taskId: h.data.tasks.acmeWebHero, filename: 'y.png', size: 1 },
    });
    assert.equal(ok.statusCode, 201);
    const del = await h.app.inject({
      method: 'DELETE',
      url: '/attachments/' + ok.json().id,
      headers: await h.auth('bob@acme.test'),
    });
    assert.equal(del.statusCode, 200);
    await denied(h, {
      method: 'DELETE',
      url: '/attachments/' + h.data.attachments.acmeHeroPng,
      headers: await h.auth('dave@globex.test'),
    });
  });
});
