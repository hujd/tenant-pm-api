import type { FastifyInstance } from 'fastify';
import { audit, newId, nowIso } from '../db.ts';
import { cacheGet, cacheSet, cacheClear } from '../cache.ts';
import { page, parseCursor, parseLimit } from './helpers.ts';
import {
  notFound,
  requireActorOrAdmin,
  requireOwnedResource,
  requireOwnedResources,
  requireSession,
  requireWriter,
} from '../authz.ts';

type ListQuery = { status?: string; limit?: string; cursor?: string; projectId?: string; assigneeId?: string };

export default async function workRoutes(app: FastifyInstance) {
  const { db } = app;

  /* --------------------------------------------------------------- projects */

  // Dashboard polls this every few seconds, so the first page is cached.
  // The cache key is namespaced per tenant — a shared key would hand one
  // tenant's rows to the next tenant that polls the same query.
  app.get<{ Querystring: ListQuery }>(
    '/projects',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      const limit = parseLimit(req.query?.limit);
      const offset = parseCursor(req.query?.cursor);
      const status = req.query?.status;
      const cacheKey = `projects:list:${ctx.tenantId}:${status ?? 'all'}:${limit}:${offset}`;

      const cached = cacheGet<{ items: unknown[]; next: number | null }>(cacheKey);
      if (cached) return reply.send({ ...cached, cached: true });

      const rows = status
        ? db
            .prepare(
              'select * from projects where tenant_id = ? and status = ? and deleted_at is null order by created_at desc limit ? offset ?',
            )
            .all(ctx.tenantId, status, limit, offset)
        : db
            .prepare(
              'select * from projects where tenant_id = ? and deleted_at is null order by created_at desc limit ? offset ?',
            )
            .all(ctx.tenantId, limit, offset);

      const payload = page(rows, limit, offset);
      cacheSet(cacheKey, payload);
      return reply.send({ ...payload, cached: false });
    },
  );

  app.post<{ Body: { name: string; ownerId?: string } }>(
    '/projects',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const name = req.body?.name;
      if (!name) return reply.status(400).send({ error: 'bad_request', message: 'name is required' });
      const ownerId = req.body?.ownerId ?? ctx.userId;
      if (ownerId !== ctx.userId) {
        const owner = db
          .prepare("select 1 from memberships where tenant_id = ? and user_id = ? and status = 'active'")
          .get(ctx.tenantId, ownerId);
        if (!owner) throw notFound('user');
      }
      const id = newId('p');
      db.prepare('insert into projects (id, tenant_id, name, status, owner_id, created_at) values (?,?,?,?,?,?)').run(
        id,
        ctx.tenantId,
        name,
        'active',
        ownerId,
        nowIso(),
      );
      cacheClear(`projects:list:${ctx.tenantId}`);
      audit(db, ctx.tenantId, ctx.userId, 'project.create', id, { name });
      return reply.status(201).send(db.prepare('select * from projects where id = ?').get(id));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      const row = requireOwnedResource(db, req.ctx!, 'project', req.params.id, 'project');
      return reply.send(row);
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; status?: string; ownerId?: string } }>(
    '/projects/:id',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const current = requireOwnedResource(db, ctx, 'project', req.params.id, 'project');
      const name = req.body?.name ?? current.name;
      const status = req.body?.status ?? current.status;
      const ownerId = req.body?.ownerId ?? current.owner_id;
      if (req.body?.ownerId && req.body.ownerId !== current.owner_id) {
        const owner = db
          .prepare("select 1 from memberships where tenant_id = ? and user_id = ? and status = 'active'")
          .get(ctx.tenantId, req.body.ownerId);
        if (!owner) throw notFound('user');
      }
      db.prepare('update projects set name = ?, status = ?, owner_id = ? where id = ?').run(
        name,
        status,
        ownerId,
        current.id,
      );
      cacheClear(`projects:list:${ctx.tenantId}`);
      audit(db, ctx.tenantId, ctx.userId, 'project.update', current.id, { name, status });
      return reply.send({ ...current, name, status, owner_id: ownerId });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const current = requireOwnedResource(db, ctx, 'project', req.params.id, 'project');
      const stamp = nowIso();
      db.prepare('update projects set deleted_at = ?, status = ? where id = ?').run(stamp, 'archived', current.id);
      db.prepare('update tasks set deleted_at = ? where tenant_id = ? and project_id = ?').run(
        stamp,
        ctx.tenantId,
        current.id,
      );
      cacheClear(`projects:list:${ctx.tenantId}`);
      audit(db, ctx.tenantId, ctx.userId, 'project.delete', current.id);
      return reply.send({ ok: true });
    },
  );

  // Bulk archive used by the "cleanup" button in the admin console.
  app.post<{ Body: { ids: string[] } }>(
    '/projects/batch-archive',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const ids = Array.isArray(req.body?.ids) ? req.body!.ids : [];
      if (ids.length === 0) return reply.status(400).send({ error: 'bad_request', message: 'ids is required' });

      // Every id is validated against the caller's tenant before any write;
      // one foreign id fails the whole request atomically.
      requireOwnedResources(db, ctx, 'project', ids, 'project');

      const stmt = db.prepare('update projects set status = ?, deleted_at = ? where tenant_id = ? and id = ?');
      const stamp = nowIso();
      for (const id of ids) stmt.run('archived', stamp, ctx.tenantId, id);
      cacheClear(`projects:list:${ctx.tenantId}`);
      audit(db, ctx.tenantId, ctx.userId, 'project.batch_archive', ids.join(','), { count: ids.length });
      return reply.send({ archived: ids.length });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/projects/:id/summary',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      const project = requireOwnedResource(db, ctx, 'project', req.params.id, 'project');
      const byStatus = db
        .prepare(
          'select status, count(*) as total from tasks where tenant_id = ? and project_id = ? and deleted_at is null group by status',
        )
        .all(ctx.tenantId, project.id);
      const assignees = db
        .prepare(
          `select t.assignee_id, u.name, count(*) as total
             from tasks t left join users u on u.id = t.assignee_id
            where t.tenant_id = ? and t.project_id = ? and t.deleted_at is null
            group by t.assignee_id`,
        )
        .all(ctx.tenantId, project.id);
      return reply.send({ project, byStatus, assignees });
    },
  );

  app.get<{ Params: { id: string }; Querystring: ListQuery }>(
    '/projects/:id/tasks',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      requireOwnedResource(db, ctx, 'project', req.params.id, 'project');
      const limit = parseLimit(req.query?.limit);
      const offset = parseCursor(req.query?.cursor);
      const rows = req.query?.status
        ? db
            .prepare(
              'select * from tasks where tenant_id = ? and project_id = ? and status = ? and deleted_at is null order by priority desc, created_at desc limit ? offset ?',
            )
            .all(ctx.tenantId, req.params.id, req.query.status, limit, offset)
        : db
            .prepare(
              'select * from tasks where tenant_id = ? and project_id = ? and deleted_at is null order by priority desc, created_at desc limit ? offset ?',
            )
            .all(ctx.tenantId, req.params.id, limit, offset);
      return reply.send(page(rows, limit, offset));
    },
  );

  /* ------------------------------------------------------------------ tasks */

  app.get<{ Querystring: ListQuery }>(
    '/tasks',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      const limit = parseLimit(req.query?.limit);
      const offset = parseCursor(req.query?.cursor);
      const filters: string[] = ['tenant_id = ?', 'deleted_at is null'];
      const params: any[] = [ctx.tenantId];
      if (req.query?.status) {
        filters.push('status = ?');
        params.push(req.query.status);
      }
      if (req.query?.projectId) {
        // Reject references into another tenant's project rather than silently
        // returning an empty page (which still confirms the id exists nowhere).
        requireOwnedResource(db, ctx, 'project', req.query.projectId, 'project');
        filters.push('project_id = ?');
        params.push(req.query.projectId);
      }
      if (req.query?.assigneeId) {
        const assignee = db
          .prepare("select 1 from memberships where tenant_id = ? and user_id = ? and status = 'active'")
          .get(ctx.tenantId, req.query.assigneeId);
        if (!assignee) throw notFound('user');
        filters.push('assignee_id = ?');
        params.push(req.query.assigneeId);
      }
      const rows = db
        .prepare(
          `select * from tasks where ${filters.join(' and ')} order by priority desc, created_at desc limit ? offset ?`,
        )
        .all(...params, limit, offset);
      return reply.send(page(rows, limit, offset));
    },
  );

  app.post<{ Body: { projectId: string; title: string; status?: string; assigneeId?: string; priority?: number } }>(
    '/tasks',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { projectId, title, status, assigneeId, priority } = req.body ?? ({} as any);
      if (!projectId || !title) {
        return reply.status(400).send({ error: 'bad_request', message: 'projectId and title are required' });
      }
      const project = requireOwnedResource(db, ctx, 'project', projectId, 'project');
      if (assigneeId) {
        const assignee = db
          .prepare("select 1 from memberships where tenant_id = ? and user_id = ? and status = 'active'")
          .get(ctx.tenantId, assigneeId);
        if (!assignee) throw notFound('user');
      }
      const id = newId('tk');
      db.prepare(
        'insert into tasks (id, tenant_id, project_id, title, status, assignee_id, priority, created_at) values (?,?,?,?,?,?,?,?)',
      ).run(
        id,
        ctx.tenantId,
        project.id,
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

  app.get<{ Params: { id: string } }>(
    '/tasks/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      return reply.send(requireOwnedResource(db, req.ctx!, 'task', req.params.id, 'task'));
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { title?: string; status?: string; assigneeId?: string; priority?: number };
  }>('/tasks/:id', { preHandler: requireWriter }, async (req, reply) => {
    const ctx = req.ctx!;
    const current = requireOwnedResource(db, ctx, 'task', req.params.id, 'task');
    if (req.body?.assigneeId) {
      const assignee = db
        .prepare("select 1 from memberships where tenant_id = ? and user_id = ? and status = 'active'")
        .get(ctx.tenantId, req.body.assigneeId);
      if (!assignee) throw notFound('user');
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

  app.delete<{ Params: { id: string } }>(
    '/tasks/:id',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const current = requireOwnedResource(db, ctx, 'task', req.params.id, 'task');
      db.prepare('update tasks set deleted_at = ? where id = ?').run(nowIso(), current.id);
      audit(db, ctx.tenantId, ctx.userId, 'task.delete', current.id);
      return reply.send({ ok: true });
    },
  );

  // Kanban drag & drop sends the whole moved column at once.
  app.post<{ Body: { items: { id: string; status?: string; priority?: number }[] } }>(
    '/tasks/batch-update',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const items = Array.isArray(req.body?.items) ? req.body!.items : [];
      if (items.length === 0) return reply.status(400).send({ error: 'bad_request', message: 'items is required' });

      const ids = items.map((i) => i.id);
      const owned = requireOwnedResources(db, ctx, 'task', ids, 'task');
      const byId = new Map(owned.map((row) => [row.id, row]));

      const stmt = db.prepare(
        'update tasks set status = coalesce(?, status), priority = coalesce(?, priority) where tenant_id = ? and id = ?',
      );
      for (const item of items) {
        if (!byId.has(item.id)) throw notFound('task');
        stmt.run(item.status ?? null, item.priority ?? null, ctx.tenantId, item.id);
      }
      audit(db, ctx.tenantId, ctx.userId, 'task.batch_update', ids[0], { count: ids.length });
      return reply.send({ updated: ids.length });
    },
  );

  app.post<{ Body: { ids: string[] } }>(
    '/tasks/batch-delete',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const ids = Array.isArray(req.body?.ids) ? req.body!.ids : [];
      if (ids.length === 0) return reply.status(400).send({ error: 'bad_request', message: 'ids is required' });

      requireOwnedResources(db, ctx, 'task', ids, 'task');

      const stmt = db.prepare('update tasks set deleted_at = ? where tenant_id = ? and id = ?');
      const stamp = nowIso();
      for (const id of ids) stmt.run(stamp, ctx.tenantId, id);
      audit(db, ctx.tenantId, ctx.userId, 'task.batch_delete', ids[0], { count: ids.length });
      return reply.send({ deleted: ids.length });
    },
  );

  app.get<{ Params: { id: string }; Querystring: ListQuery }>(
    '/tasks/:id/comments',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      requireOwnedResource(db, ctx, 'task', req.params.id, 'task');
      const limit = parseLimit(req.query?.limit);
      const rows = db
        .prepare('select * from comments where tenant_id = ? and task_id = ? order by created_at asc limit ?')
        .all(ctx.tenantId, req.params.id, limit);
      return reply.send({ items: rows });
    },
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/tasks/:id/comments',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const task = requireOwnedResource(db, ctx, 'task', req.params.id, 'task');
      const body = req.body?.body;
      if (!body) return reply.status(400).send({ error: 'bad_request', message: 'body is required' });
      const id = newId('cm');
      db.prepare('insert into comments (id, tenant_id, task_id, user_id, body, created_at) values (?,?,?,?,?,?)').run(
        id,
        ctx.tenantId,
        task.id,
        ctx.userId,
        body,
        nowIso(),
      );
      return reply.status(201).send(db.prepare('select * from comments where id = ?').get(id));
    },
  );

  /* --------------------------------------------------------------- comments */

  app.get<{ Querystring: { taskId?: string; limit?: string } }>(
    '/comments',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      const limit = parseLimit(req.query?.limit);
      const rows = req.query?.taskId
        ? db
            .prepare('select * from comments where tenant_id = ? and task_id = ? order by created_at asc limit ?')
            .all(ctx.tenantId, req.query.taskId, limit)
        : db
            .prepare('select * from comments where tenant_id = ? order by created_at desc limit ?')
            .all(ctx.tenantId, limit);
      return reply.send({ items: rows });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/comments/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      return reply.send(requireOwnedResource(db, req.ctx!, 'comment', req.params.id, 'comment'));
    },
  );

  app.patch<{ Params: { id: string }; Body: { body: string } }>(
    '/comments/:id',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const current = requireOwnedResource(db, ctx, 'comment', req.params.id, 'comment');
      requireActorOrAdmin(ctx, current);
      const body = req.body?.body ?? current.body;
      db.prepare('update comments set body = ? where id = ?').run(body, current.id);
      return reply.send({ ...current, body });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/comments/:id',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const current = requireOwnedResource(db, ctx, 'comment', req.params.id, 'comment');
      requireActorOrAdmin(ctx, current);
      db.prepare('delete from comments where id = ?').run(current.id);
      return reply.send({ ok: true });
    },
  );

  /* ------------------------------------------------------------ attachments */

  app.post<{ Body: { taskId: string; filename: string; size?: number } }>(
    '/attachments',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { taskId, filename, size } = req.body ?? ({} as any);
      if (!taskId || !filename) {
        return reply.status(400).send({ error: 'bad_request', message: 'taskId and filename are required' });
      }
      const task = requireOwnedResource(db, ctx, 'task', taskId, 'task');
      const id = newId('at');
      const storageKey = `blob/${ctx.tenantId}/${id}/${filename}`;
      db.prepare(
        'insert into attachments (id, tenant_id, task_id, filename, size, storage_key, created_at) values (?,?,?,?,?,?,?)',
      ).run(id, ctx.tenantId, task.id, filename, Number(size ?? 0), storageKey, nowIso());
      return reply.status(201).send(db.prepare('select * from attachments where id = ?').get(id));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/attachments/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      return reply.send(requireOwnedResource(db, req.ctx!, 'attachment', req.params.id, 'attachment'));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/attachments/:id/download',
    { preHandler: requireSession },
    async (req, reply) => {
      const row = requireOwnedResource(db, req.ctx!, 'attachment', req.params.id, 'attachment');
      return reply.send({
        url: `/storage/${row.storage_key}`,
        filename: row.filename,
        size: row.size,
        expiresIn: 900,
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/attachments/:id',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const row = requireOwnedResource(db, ctx, 'attachment', req.params.id, 'attachment');
      db.prepare('delete from attachments where id = ?').run(row.id);
      audit(db, ctx.tenantId, ctx.userId, 'attachment.delete', row.id);
      return reply.send({ ok: true });
    },
  );
}
