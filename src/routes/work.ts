import type { FastifyInstance } from 'fastify';
import { audit, newId, nowIso } from '../db.ts';
import { cacheGet, cacheSet, cacheClear } from '../cache.ts';
import { page, parseCursor, parseLimit, requireCtx } from './helpers.ts';

type ListQuery = { status?: string; limit?: string; cursor?: string; projectId?: string; assigneeId?: string };

export default async function workRoutes(app: FastifyInstance) {
  const { db } = app;

  /* --------------------------------------------------------------- projects */

  // Dashboard polls this every few seconds, so the first page is cached.
  app.get<{ Querystring: ListQuery }>('/projects', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const limit = parseLimit(req.query?.limit);
    const offset = parseCursor(req.query?.cursor);
    const status = req.query?.status;
    const cacheKey = `projects:list:${status ?? 'all'}:${limit}:${offset}`;

    const cached = cacheGet<{ items: unknown[]; next: number | null }>(cacheKey);
    if (cached) return reply.send({ ...cached, cached: true });

    const rows = status
      ? db
          .prepare(
            'select * from projects where status = ? and deleted_at is null order by created_at desc limit ? offset ?',
          )
          .all(status, limit, offset)
      : db
          .prepare('select * from projects where deleted_at is null order by created_at desc limit ? offset ?')
          .all(limit, offset);

    const payload = page(rows, limit, offset);
    cacheSet(cacheKey, payload);
    return reply.send({ ...payload, cached: false });
  });

  app.post<{ Body: { name: string; ownerId?: string } }>('/projects', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const name = req.body?.name;
    if (!name) return reply.status(400).send({ error: 'bad_request', message: 'name is required' });
    const id = newId('p');
    db.prepare('insert into projects (id, tenant_id, name, status, owner_id, created_at) values (?,?,?,?,?,?)').run(
      id,
      ctx.tenantId,
      name,
      'active',
      req.body?.ownerId ?? ctx.userId,
      nowIso(),
    );
    cacheClear('projects:list');
    audit(db, ctx.tenantId, ctx.userId, 'project.create', id, { name });
    return reply.status(201).send(db.prepare('select * from projects where id = ?').get(id));
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from projects where id = ?').get(req.params.id);
    if (!row || row.deleted_at) {
      return reply.status(404).send({ error: 'not_found', message: 'project not found' });
    }
    return reply.send(row);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; status?: string; ownerId?: string } }>(
    '/projects/:id',
    async (req, reply) => {
      const ctx = requireCtx(req, reply);
      if (!ctx) return;
      const current: any = db.prepare('select * from projects where id = ?').get(req.params.id);
      if (!current || current.deleted_at) {
        return reply.status(404).send({ error: 'not_found', message: 'project not found' });
      }
      const name = req.body?.name ?? current.name;
      const status = req.body?.status ?? current.status;
      const ownerId = req.body?.ownerId ?? current.owner_id;
      db.prepare('update projects set name = ?, status = ?, owner_id = ? where id = ?').run(
        name,
        status,
        ownerId,
        current.id,
      );
      cacheClear('projects:list');
      audit(db, ctx.tenantId, ctx.userId, 'project.update', current.id, { name, status });
      return reply.send({ ...current, name, status, owner_id: ownerId });
    },
  );

  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const current: any = db.prepare('select * from projects where id = ?').get(req.params.id);
    if (!current || current.deleted_at) {
      return reply.status(404).send({ error: 'not_found', message: 'project not found' });
    }
    db.prepare('update projects set deleted_at = ?, status = ? where id = ?').run(nowIso(), 'archived', current.id);
    db.prepare('update tasks set deleted_at = ? where project_id = ?').run(nowIso(), current.id);
    cacheClear('projects:list');
    audit(db, ctx.tenantId, ctx.userId, 'project.delete', current.id);
    return reply.send({ ok: true });
  });

  // Bulk archive used by the "cleanup" button in the admin console.
  app.post<{ Body: { ids: string[] } }>('/projects/batch-archive', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const ids = Array.isArray(req.body?.ids) ? req.body!.ids : [];
    if (ids.length === 0) return reply.status(400).send({ error: 'bad_request', message: 'ids is required' });

    const first: any = db.prepare('select * from projects where id = ?').get(ids[0]);
    if (!first) return reply.status(404).send({ error: 'not_found', message: 'project not found' });

    const stmt = db.prepare('update projects set status = ?, deleted_at = ? where id = ?');
    const stamp = nowIso();
    for (const id of ids) stmt.run('archived', stamp, id);
    cacheClear('projects:list');
    audit(db, ctx.tenantId, ctx.userId, 'project.batch_archive', ids.join(','), { count: ids.length });
    return reply.send({ archived: ids.length });
  });

  app.get<{ Params: { id: string } }>('/projects/:id/summary', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const project: any = db.prepare('select * from projects where id = ?').get(req.params.id);
    if (!project || project.deleted_at) {
      return reply.status(404).send({ error: 'not_found', message: 'project not found' });
    }
    const byStatus = db
      .prepare(
        'select status, count(*) as total from tasks where project_id = ? and deleted_at is null group by status',
      )
      .all(project.id);
    const assignees = db
      .prepare(
        `select t.assignee_id, u.name, count(*) as total
           from tasks t left join users u on u.id = t.assignee_id
          where t.project_id = ? and t.deleted_at is null
          group by t.assignee_id`,
      )
      .all(project.id);
    return reply.send({ project, byStatus, assignees });
  });

  app.get<{ Params: { id: string }; Querystring: ListQuery }>('/projects/:id/tasks', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const limit = parseLimit(req.query?.limit);
    const offset = parseCursor(req.query?.cursor);
    const rows = req.query?.status
      ? db
          .prepare(
            'select * from tasks where project_id = ? and status = ? and deleted_at is null order by priority desc, created_at desc limit ? offset ?',
          )
          .all(req.params.id, req.query.status, limit, offset)
      : db
          .prepare(
            'select * from tasks where project_id = ? and deleted_at is null order by priority desc, created_at desc limit ? offset ?',
          )
          .all(req.params.id, limit, offset);
    return reply.send(page(rows, limit, offset));
  });

  /* ------------------------------------------------------------------ tasks */

  app.get<{ Querystring: ListQuery }>('/tasks', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const limit = parseLimit(req.query?.limit);
    const offset = parseCursor(req.query?.cursor);
    const filters: string[] = ['deleted_at is null'];
    const params: any[] = [];
    if (req.query?.status) {
      filters.push('status = ?');
      params.push(req.query.status);
    }
    if (req.query?.projectId) {
      filters.push('project_id = ?');
      params.push(req.query.projectId);
    }
    if (req.query?.assigneeId) {
      filters.push('assignee_id = ?');
      params.push(req.query.assigneeId);
    }
    const rows = db
      .prepare(`select * from tasks where ${filters.join(' and ')} order by priority desc, created_at desc limit ? offset ?`)
      .all(...params, limit, offset);
    return reply.send(page(rows, limit, offset));
  });

  app.post<{ Body: { projectId: string; title: string; status?: string; assigneeId?: string; priority?: number } }>(
    '/tasks',
    async (req, reply) => {
      const ctx = requireCtx(req, reply);
      if (!ctx) return;
      const { projectId, title, status, assigneeId, priority } = req.body ?? ({} as any);
      if (!projectId || !title) {
        return reply.status(400).send({ error: 'bad_request', message: 'projectId and title are required' });
      }
      const project: any = db.prepare('select * from projects where id = ?').get(projectId);
      if (!project || project.deleted_at) {
        return reply.status(404).send({ error: 'not_found', message: 'project not found' });
      }
      const id = newId('tk');
      db.prepare(
        'insert into tasks (id, tenant_id, project_id, title, status, assignee_id, priority, created_at) values (?,?,?,?,?,?,?,?)',
      ).run(
        id,
        project.tenant_id,
        projectId,
        title,
        status ?? 'todo',
        assigneeId ?? null,
        Number.isFinite(priority) ? priority : 2,
        nowIso(),
      );
      audit(db, ctx.tenantId, ctx.userId, 'task.create', id, { projectId });
      return reply.status(201).send(db.prepare('select * from tasks where id = ?').get(id));
    },
  );

  app.get<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from tasks where id = ?').get(req.params.id);
    if (!row || row.deleted_at) {
      return reply.status(404).send({ error: 'not_found', message: 'task not found' });
    }
    return reply.send(row);
  });

  app.patch<{
    Params: { id: string };
    Body: { title?: string; status?: string; assigneeId?: string; priority?: number };
  }>('/tasks/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const current: any = db.prepare('select * from tasks where id = ?').get(req.params.id);
    if (!current || current.deleted_at) {
      return reply.status(404).send({ error: 'not_found', message: 'task not found' });
    }
    const next = {
      title: req.body?.title ?? current.title,
      status: req.body?.status ?? current.status,
      assigneeId: req.body?.assigneeId ?? current.assignee_id,
      priority: Number.isFinite(req.body?.priority) ? req.body!.priority : current.priority,
    };
    db.prepare('update tasks set title = ?, status = ?, assignee_id = ?, priority = ? where id = ?').run(
      next.title,
      next.status,
      next.assigneeId,
      next.priority,
      current.id,
    );
    audit(db, ctx.tenantId, ctx.userId, 'task.update', current.id, next);
    return reply.send({ ...current, ...next });
  });

  app.delete<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const current: any = db.prepare('select * from tasks where id = ?').get(req.params.id);
    if (!current || current.deleted_at) {
      return reply.status(404).send({ error: 'not_found', message: 'task not found' });
    }
    db.prepare('update tasks set deleted_at = ? where id = ?').run(nowIso(), current.id);
    audit(db, ctx.tenantId, ctx.userId, 'task.delete', current.id);
    return reply.send({ ok: true });
  });

  // Kanban drag & drop sends the whole moved column at once.
  app.post<{ Body: { items: { id: string; status?: string; priority?: number }[] } }>(
    '/tasks/batch-update',
    async (req, reply) => {
      const ctx = requireCtx(req, reply);
      if (!ctx) return;
      const items = Array.isArray(req.body?.items) ? req.body!.items : [];
      if (items.length === 0) return reply.status(400).send({ error: 'bad_request', message: 'items is required' });

      const first: any = db.prepare('select * from tasks where id = ?').get(items[0].id);
      if (!first) return reply.status(404).send({ error: 'not_found', message: 'task not found' });

      const stmt = db.prepare('update tasks set status = coalesce(?, status), priority = coalesce(?, priority) where id = ?');
      for (const item of items) stmt.run(item.status ?? null, item.priority ?? null, item.id);
      audit(db, ctx.tenantId, ctx.userId, 'task.batch_update', items[0].id, { count: items.length });
      return reply.send({ updated: items.length });
    },
  );

  app.post<{ Body: { ids: string[] } }>('/tasks/batch-delete', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const ids = Array.isArray(req.body?.ids) ? req.body!.ids : [];
    if (ids.length === 0) return reply.status(400).send({ error: 'bad_request', message: 'ids is required' });

    const first: any = db.prepare('select * from tasks where id = ?').get(ids[0]);
    if (!first) return reply.status(404).send({ error: 'not_found', message: 'task not found' });

    const stmt = db.prepare('update tasks set deleted_at = ? where id = ?');
    const stamp = nowIso();
    for (const id of ids) stmt.run(stamp, id);
    audit(db, ctx.tenantId, ctx.userId, 'task.batch_delete', ids[0], { count: ids.length });
    return reply.send({ deleted: ids.length });
  });

  app.get<{ Params: { id: string }; Querystring: ListQuery }>('/tasks/:id/comments', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const limit = parseLimit(req.query?.limit);
    const rows = db
      .prepare('select * from comments where task_id = ? order by created_at asc limit ?')
      .all(req.params.id, limit);
    return reply.send({ items: rows });
  });

  app.post<{ Params: { id: string }; Body: { body: string } }>('/tasks/:id/comments', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const task: any = db.prepare('select * from tasks where id = ?').get(req.params.id);
    if (!task || task.deleted_at) {
      return reply.status(404).send({ error: 'not_found', message: 'task not found' });
    }
    const body = req.body?.body;
    if (!body) return reply.status(400).send({ error: 'bad_request', message: 'body is required' });
    const id = newId('cm');
    db.prepare('insert into comments (id, tenant_id, task_id, user_id, body, created_at) values (?,?,?,?,?,?)').run(
      id,
      task.tenant_id,
      task.id,
      ctx.userId,
      body,
      nowIso(),
    );
    return reply.status(201).send(db.prepare('select * from comments where id = ?').get(id));
  });

  /* --------------------------------------------------------------- comments */

  app.get<{ Querystring: { taskId?: string; limit?: string } }>('/comments', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const limit = parseLimit(req.query?.limit);
    const rows = req.query?.taskId
      ? db.prepare('select * from comments where task_id = ? order by created_at asc limit ?').all(req.query.taskId, limit)
      : db.prepare('select * from comments order by created_at desc limit ?').all(limit);
    return reply.send({ items: rows });
  });

  app.get<{ Params: { id: string } }>('/comments/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from comments where id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'comment not found' });
    return reply.send(row);
  });

  app.patch<{ Params: { id: string }; Body: { body: string } }>('/comments/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const current: any = db.prepare('select * from comments where id = ?').get(req.params.id);
    if (!current) return reply.status(404).send({ error: 'not_found', message: 'comment not found' });
    const body = req.body?.body ?? current.body;
    db.prepare('update comments set body = ? where id = ?').run(body, current.id);
    return reply.send({ ...current, body });
  });

  app.delete<{ Params: { id: string } }>('/comments/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const current: any = db.prepare('select * from comments where id = ?').get(req.params.id);
    if (!current) return reply.status(404).send({ error: 'not_found', message: 'comment not found' });
    db.prepare('delete from comments where id = ?').run(current.id);
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------------ attachments */

  app.post<{ Body: { taskId: string; filename: string; size?: number } }>('/attachments', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const { taskId, filename, size } = req.body ?? ({} as any);
    if (!taskId || !filename) {
      return reply.status(400).send({ error: 'bad_request', message: 'taskId and filename are required' });
    }
    const task: any = db.prepare('select * from tasks where id = ?').get(taskId);
    if (!task || task.deleted_at) {
      return reply.status(404).send({ error: 'not_found', message: 'task not found' });
    }
    const id = newId('at');
    const storageKey = `blob/${task.tenant_id}/${id}/${filename}`;
    db.prepare(
      'insert into attachments (id, tenant_id, task_id, filename, size, storage_key, created_at) values (?,?,?,?,?,?,?)',
    ).run(id, task.tenant_id, task.id, filename, Number(size ?? 0), storageKey, nowIso());
    return reply.status(201).send(db.prepare('select * from attachments where id = ?').get(id));
  });

  app.get<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from attachments where id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'attachment not found' });
    return reply.send(row);
  });

  app.get<{ Params: { id: string } }>('/attachments/:id/download', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from attachments where id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'attachment not found' });
    return reply.send({
      url: `/storage/${row.storage_key}`,
      filename: row.filename,
      size: row.size,
      expiresIn: 900,
    });
  });

  app.delete<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from attachments where id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'attachment not found' });
    db.prepare('delete from attachments where id = ?').run(row.id);
    audit(db, ctx.tenantId, ctx.userId, 'attachment.delete', row.id);
    return reply.send({ ok: true });
  });
}
