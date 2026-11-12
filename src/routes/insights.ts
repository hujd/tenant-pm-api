import type { FastifyInstance } from 'fastify';
import { audit, newId, nowIso } from '../db.ts';
import { cacheGet, cacheSet } from '../cache.ts';
import { page, parseCursor, parseLimit } from './helpers.ts';
import {
  requireOwnedResource,
  requireSession,
  requireWriter,
} from '../authz.ts';

type ExportFilters = { status?: string; projectId?: string; tenantId?: string; from?: string; to?: string };

export default async function insightRoutes(app: FastifyInstance) {
  const { db } = app;

  /* --------------------------------------------------------------- exports */

  app.post<{ Body: { kind?: string; filters?: ExportFilters } }>(
    '/exports',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      const kind = req.body?.kind ?? 'tasks';
      if (!['tasks', 'projects', 'comments'].includes(kind)) {
        return reply.status(400).send({ error: 'bad_request', message: 'unsupported export kind' });
      }
      // The tenant scope always comes from the session, never from the
      // request body — otherwise a caller could export another tenant's rows
      // by putting their id into filters.tenantId.
      const rawFilters = req.body?.filters ?? {};
      if (rawFilters.projectId) {
        requireOwnedResource(db, ctx, 'project', rawFilters.projectId, 'project');
      }
      const filters: ExportFilters = { ...rawFilters, tenantId: ctx.tenantId };
      const id = newId('ex');
      db.prepare('insert into export_jobs (id, tenant_id, user_id, kind, filters, status, created_at) values (?,?,?,?,?,?,?)').run(
        id,
        ctx.tenantId,
        ctx.userId,
        kind,
        JSON.stringify(filters),
        'queued',
        nowIso(),
      );
      audit(db, ctx.tenantId, ctx.userId, 'export.create', id, { kind });
      return reply.status(201).send(db.prepare('select * from export_jobs where id = ?').get(id));
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/exports',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      const limit = parseLimit(req.query?.limit);
      const offset = parseCursor(req.query?.cursor);
      const rows = db
        .prepare(
          'select * from export_jobs where tenant_id = ? order by created_at desc limit ? offset ?',
        )
        .all(ctx.tenantId, limit, offset);
      return reply.send(page(rows, limit, offset));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/exports/:id',
    { preHandler: requireSession },
    async (req, reply) => {
      return reply.send(requireOwnedResource(db, req.ctx!, 'exportJob', req.params.id, 'export job'));
    },
  );

  // Runs the stored filter again and returns the rows inline (the real
  // deployment streams it to object storage; this is the local dev path).
  app.get<{ Params: { id: string } }>(
    '/exports/:id/download',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      const job = requireOwnedResource(db, ctx, 'exportJob', req.params.id, 'export job');
      const filters: ExportFilters = JSON.parse(job.filters || '{}');
      // Defence in depth: tenant scoping is pinned from the session again at
      // execution time, so even a hand-crafted row cannot escape the tenant.
      const where: string[] = ['tenant_id = ?', 'deleted_at is null'];
      const params: any[] = [ctx.tenantId];
      if (filters.status) {
        where.push('status = ?');
        params.push(filters.status);
      }
      if (filters.projectId) {
        where.push('project_id = ?');
        params.push(filters.projectId);
      }
      if (filters.from) {
        where.push('created_at >= ?');
        params.push(filters.from);
      }
      if (filters.to) {
        where.push('created_at <= ?');
        params.push(filters.to);
      }
      // `kind` is validated against a fixed allowlist before touching SQL.
      const table = job.kind === 'projects' ? 'projects' : job.kind === 'comments' ? 'comments' : 'tasks';
      const rows = db.prepare(`select * from ${table} where ${where.join(' and ')}`).all(...params);
      return reply.send({
        jobId: job.id,
        kind: job.kind,
        filters: { ...filters, tenantId: ctx.tenantId },
        rowCount: rows.length,
        rows,
      });
    },
  );

  /* ---------------------------------------------------------------- search */

  // Every search query is constrained to the caller's tenant. The users
  // sub-query additionally only returns co-members of the same workspace.
  function searchAll(tenantId: string, term: string, limit: number) {
    const like = `%${term}%`;
    return {
      projects: db
        .prepare('select * from projects where tenant_id = ? and name like ? and deleted_at is null limit ?')
        .all(tenantId, like, limit),
      tasks: db
        .prepare('select * from tasks where tenant_id = ? and title like ? and deleted_at is null limit ?')
        .all(tenantId, like, limit),
      comments: db
        .prepare('select * from comments where tenant_id = ? and body like ? limit ?')
        .all(tenantId, like, limit),
      users: db
        .prepare(
          `select u.id, u.name, u.email from users u
             join memberships m on m.user_id = u.id and m.status = 'active'
            where m.tenant_id = ? and (u.name like ? or u.email like ?) limit ?`,
        )
        .all(tenantId, like, like, limit),
    };
  }

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/search',
    { preHandler: requireSession },
    async (req, reply) => {
      const q = (req.query?.q ?? '').trim();
      if (q.length < 2) return reply.status(400).send({ error: 'bad_request', message: 'q must be at least 2 chars' });
      const limit = parseLimit(req.query?.limit, 20);
      return reply.send({ q, ...searchAll(req.ctx!.tenantId, q, limit) });
    },
  );

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/search/tasks',
    { preHandler: requireSession },
    async (req, reply) => {
      const q = (req.query?.q ?? '').trim();
      const limit = parseLimit(req.query?.limit, 20);
      return reply.send({ items: searchAll(req.ctx!.tenantId, q, limit).tasks });
    },
  );

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/search/projects',
    { preHandler: requireSession },
    async (req, reply) => {
      const q = (req.query?.q ?? '').trim();
      const limit = parseLimit(req.query?.limit, 20);
      return reply.send({ items: searchAll(req.ctx!.tenantId, q, limit).projects });
    },
  );

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/search/users',
    { preHandler: requireSession },
    async (req, reply) => {
      const q = (req.query?.q ?? '').trim();
      const limit = parseLimit(req.query?.limit, 20);
      return reply.send({ items: searchAll(req.ctx!.tenantId, q, limit).users });
    },
  );

  /* --------------------------------------------------------------- reports */

  app.get('/reports/overview', { preHandler: requireSession }, async (req, reply) => {
    const ctx = req.ctx!;
    const cacheKey = `reports:overview:${ctx.tenantId}`;
    const cached = cacheGet<unknown>(cacheKey);
    if (cached) return reply.send({ ...(cached as object), cached: true });

    const projects: any = db
      .prepare('select count(*) as total from projects where tenant_id = ? and deleted_at is null')
      .get(ctx.tenantId);
    const tasks: any = db
      .prepare('select count(*) as total from tasks where tenant_id = ? and deleted_at is null')
      .get(ctx.tenantId);
    const done: any = db
      .prepare(
        "select count(*) as total from tasks where tenant_id = ? and status = 'done' and deleted_at is null",
      )
      .get(ctx.tenantId);
    const urgentOpen = db
      .prepare(
        "select count(*) as total from tasks where tenant_id = ? and status != 'done' and priority = 1 and deleted_at is null",
      )
      .get(ctx.tenantId);
    const payload = {
      projects: projects.total,
      tasks: tasks.total,
      done: done.total,
      urgentOpen: (urgentOpen as any).total,
      completionRate: tasks.total ? Number((done.total / tasks.total).toFixed(3)) : 0,
    };
    cacheSet(cacheKey, payload);
    return reply.send({ ...payload, cached: false });
  });

  app.get('/reports/tasks-by-status', { preHandler: requireSession }, async (req, reply) => {
    const rows = db
      .prepare(
        'select status, count(*) as total from tasks where tenant_id = ? and deleted_at is null group by status order by total desc',
      )
      .all(req.ctx!.tenantId);
    return reply.send({ items: rows });
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/reports/activity',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      const limit = parseLimit(req.query?.limit, 50);
      const rows = db
        .prepare(
          `select a.*, u.name as actor_name
             from audit_logs a left join users u on u.id = a.actor_id
            where a.tenant_id = ?
            order by a.created_at desc limit ?`,
        )
        .all(ctx.tenantId, limit);
      return reply.send({ items: rows });
    },
  );

  app.get('/reports/utilization', { preHandler: requireSession }, async (req, reply) => {
    const ctx = req.ctx!;
    const rows = db
      .prepare(
        `select u.id as user_id, u.name,
                count(t.id) as open_tasks,
                sum(case when t.status = 'done' then 1 else 0 end) as done_tasks
           from users u
           join memberships m on m.user_id = u.id and m.status = 'active' and m.tenant_id = ?
           left join tasks t on t.assignee_id = u.id and t.tenant_id = ? and t.deleted_at is null
          group by u.id
          order by open_tasks desc`,
      )
      .all(ctx.tenantId, ctx.tenantId);
    return reply.send({ items: rows });
  });

  app.get<{ Querystring: { format?: string; kind?: string } }>(
    '/reports/export',
    { preHandler: requireSession },
    async (req, reply) => {
      const ctx = req.ctx!;
      const kind = req.query?.kind ?? 'tasks';
      // Fixed allowlist — the value can only pick between two known tables.
      const table = kind === 'projects' ? 'projects' : 'tasks';
      const rows = db
        .prepare(`select * from ${table} where tenant_id = ? and deleted_at is null order by created_at desc`)
        .all(ctx.tenantId);
      const format = req.query?.format === 'csv' ? 'csv' : 'json';
      if (format === 'csv') {
        const header = Object.keys(rows[0] ?? { id: '' }).join(',');
        const body = rows
          .map((r: any) =>
            Object.values(r)
              .map((v) => String(v ?? ''))
              .join(','),
          )
          .join('\n');
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .send(`${header}\n${body}`);
      }
      return reply.send({ kind, rowCount: rows.length, rows });
    },
  );

  /* -------------------------------------------------------------- webhooks */

  app.get('/webhooks', { preHandler: requireSession }, async (req, reply) => {
    const rows = db
      .prepare('select * from webhooks where tenant_id = ? order by created_at desc')
      .all(req.ctx!.tenantId);
    return reply.send({ items: rows });
  });

  app.post<{ Body: { url: string; event?: string } }>(
    '/webhooks',
    { preHandler: requireWriter },
    async (req, reply) => {
      const ctx = req.ctx!;
      const url = req.body?.url;
      if (!url || !/^https?:\/\//.test(url)) {
        return reply.status(400).send({ error: 'bad_request', message: 'url must be http(s)' });
      }
      const id = newId('wh');
      db.prepare('insert into webhooks (id, tenant_id, url, event, created_at) values (?,?,?,?,?)').run(
        id,
        ctx.tenantId,
        url,
        req.body?.event ?? 'task.updated',
        nowIso(),
      );
      return reply.status(201).send(db.prepare('select * from webhooks where id = ?').get(id));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/webhooks/:id',
    { preHandler: requireWriter },
    async (req, reply) => {
      const row = requireOwnedResource(db, req.ctx!, 'webhook', req.params.id, 'webhook');
      db.prepare('delete from webhooks where id = ?').run(row.id);
      return reply.send({ ok: true });
    },
  );
}
