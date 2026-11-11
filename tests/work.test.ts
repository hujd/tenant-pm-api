import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.ts';
import { cacheClear } from '../src/cache.ts';

describe('projects', () => {
  beforeEach(() => cacheClear());

  it('creates a project and lists it', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/projects',
      headers,
      payload: { name: 'Q1 Roadmap' },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    cacheClear();
    const list = await harness.app.inject({ method: 'GET', url: '/projects', headers });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().items.map((p: any) => p.id).includes(id));
  });

  it('requires a name', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'POST', url: '/projects', headers, payload: {} });
    assert.equal(res.statusCode, 400);
  });

  it('reads, updates and summarises a project', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/projects',
      headers,
      payload: { name: 'Billing Overhaul' },
    });
    const id = created.json().id;

    const read = await harness.app.inject({ method: 'GET', url: '/projects/' + id, headers });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().name, 'Billing Overhaul');

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/projects/' + id,
      headers,
      payload: { status: 'paused' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().status, 'paused');

    const summary = await harness.app.inject({ method: 'GET', url: '/projects/' + id + '/summary', headers });
    assert.equal(summary.statusCode, 200);
    assert.ok(Array.isArray(summary.json().byStatus));
  });

  it('lists the tasks of a project', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const projectId = harness.data.projects.acmeWeb;
    const res = await harness.app.inject({ method: 'GET', url: '/projects/' + projectId + '/tasks', headers });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().items.length >= 3);
  });

  it('archives several projects in one call', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const ids: string[] = [];
    for (const name of ['Temp A', 'Temp B']) {
      const created = await harness.app.inject({ method: 'POST', url: '/projects', headers, payload: { name } });
      ids.push(created.json().id);
    }
    const res = await harness.app.inject({
      method: 'POST',
      url: '/projects/batch-archive',
      headers,
      payload: { ids },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().archived, 2);
  });

  it('soft deletes a project and hides it afterwards', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/projects',
      headers,
      payload: { name: 'Deprecated' },
    });
    const id = created.json().id;
    const del = await harness.app.inject({ method: 'DELETE', url: '/projects/' + id, headers });
    assert.equal(del.statusCode, 200);
    const read = await harness.app.inject({ method: 'GET', url: '/projects/' + id, headers });
    assert.equal(read.statusCode, 404);
  });
});

describe('tasks', () => {
  it('creates a task inside a project', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const res = await harness.app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { projectId: harness.data.projects.acmeWeb, title: 'Add cookie banner', priority: 1 },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().status, 'todo');
    assert.equal(res.json().priority, 1);
  });

  it('rejects a task without a project', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const res = await harness.app.inject({ method: 'POST', url: '/tasks', headers, payload: { title: 'orphan' } });
    assert.equal(res.statusCode, 400);
  });

  it('filters tasks by status', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/tasks?status=in_progress', headers });
    assert.equal(res.statusCode, 200);
    for (const task of res.json().items) assert.equal(task.status, 'in_progress');
  });

  it('reads and updates a task', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const taskId = harness.data.tasks.acmeWebSeo;
    const read = await harness.app.inject({ method: 'GET', url: '/tasks/' + taskId, headers });
    assert.equal(read.statusCode, 200);

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/tasks/' + taskId,
      headers,
      payload: { status: 'done', priority: 2 },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().status, 'done');
  });

  it('moves a column in one batch call', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const items = [
      { id: harness.data.tasks.acmeWebSeo, status: 'in_progress' },
      { id: harness.data.tasks.acmeMobilePush, status: 'done' },
    ];
    const res = await harness.app.inject({ method: 'POST', url: '/tasks/batch-update', headers, payload: { items } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().updated, 2);
  });

  it('deletes several tasks in one batch call', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const ids = [harness.data.tasks.acmeWebSeo, harness.data.tasks.acmeWebCms];
    const res = await harness.app.inject({ method: 'POST', url: '/tasks/batch-delete', headers, payload: { ids } });
    assert.equal(res.statusCode, 200);
    const after = await harness.app.inject({ method: 'GET', url: '/tasks/' + ids[0], headers });
    assert.equal(after.statusCode, 404);
  });

  it('adds a comment through the task endpoint', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const taskId = harness.data.tasks.acmeWebHero;
    const created = await harness.app.inject({
      method: 'POST',
      url: '/tasks/' + taskId + '/comments',
      headers,
      payload: { body: 'Hero copy approved.' },
    });
    assert.equal(created.statusCode, 201);
    const list = await harness.app.inject({ method: 'GET', url: '/tasks/' + taskId + '/comments', headers });
    assert.ok(list.json().items.length >= 3);
  });
});

describe('comments', () => {
  it('lists comments for a task and edits one', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const taskId = harness.data.tasks.acmeWebHero;
    const list = await harness.app.inject({ method: 'GET', url: '/comments?taskId=' + taskId, headers });
    assert.equal(list.statusCode, 200);
    const commentId = list.json().items[0].id;

    const read = await harness.app.inject({ method: 'GET', url: '/comments/' + commentId, headers });
    assert.equal(read.statusCode, 200);

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/comments/' + commentId,
      headers,
      payload: { body: 'Design handoff updated.' },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().body, 'Design handoff updated.');
  });

  it('deletes a comment', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('alice@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/tasks/' + harness.data.tasks.acmeWebHero + '/comments',
      headers,
      payload: { body: 'temporary' },
    });
    const res = await harness.app.inject({ method: 'DELETE', url: '/comments/' + created.json().id, headers });
    assert.equal(res.statusCode, 200);
  });
});

describe('attachments', () => {
  it('uploads metadata, reads it back and hands out a download link', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/attachments',
      headers,
      payload: { taskId: harness.data.tasks.acmeWebHero, filename: 'spec.pdf', size: 1024 },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    const read = await harness.app.inject({ method: 'GET', url: '/attachments/' + id, headers });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().filename, 'spec.pdf');

    const link = await harness.app.inject({ method: 'GET', url: '/attachments/' + id + '/download', headers });
    assert.equal(link.statusCode, 200);
    assert.ok(link.json().url.includes('/storage/'));
    assert.equal(link.json().expiresIn, 900);
  });

  it('deletes an attachment', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const created = await harness.app.inject({
      method: 'POST',
      url: '/attachments',
      headers,
      payload: { taskId: harness.data.tasks.acmeMobilePush, filename: 'log.txt', size: 64 },
    });
    const res = await harness.app.inject({ method: 'DELETE', url: '/attachments/' + created.json().id, headers });
    assert.equal(res.statusCode, 200);
  });

  it('404s an unknown attachment', async () => {
    const harness = await makeHarness();
    const headers = await harness.as('bob@acme.test');
    const res = await harness.app.inject({ method: 'GET', url: '/attachments/at_missing', headers });
    assert.equal(res.statusCode, 404);
  });
});
