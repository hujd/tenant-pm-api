import type { FastifyInstance } from 'fastify';
import { audit, newId, nowIso } from '../db.ts';
import { cacheGet, cacheSet } from '../cache.ts';
import { page, parseCursor, parseLimit, requireCtx } from './helpers.ts';

type ExportFilters = { status?: string; projectId?: string; tenantId?: string; from?: string; to?: string };

export default async function insightRoutes(app: FastifyInstance) {
  const { db } = app;

  /* --------------------------------------------------------------- exports */

  app.post<{ Body: { kind?: string; filters?: ExportFilters } }>('/exports', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const kind = req.body?.kind ?? 'tasks';
    if (!['tasks', 'projects', 'comments'].includes(kind)) {
      return reply.status(400).send({ error: 'bad_request', message: 'unsupported export kind' });
    }
    const id = newId('ex');
    db.prepare('insert into export_jobs (id, tenant_id, user_id, kind, filters, status, created_at) values (?,?,?,?,?,?,?)').run(
      id,
      ctx.tenantId,
      ctx.userId,
      kind,
      JSON.stringify(req.body?.filters ?? {}),
      'queued',
      nowIso(),
    );
    audit(db, ctx.tenantId, ctx.userId, 'export.create', id, { kind });
    return reply.status(201).send(db.prepare('select * from export_jobs where id = ?').get(id));
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/exports', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const limit = parseLimit(req.query?.limit);
    const offset = parseCursor(req.query?.cursor);
    const rows = db
      .prepare('select * from export_jobs order by created_at desc limit ? offset ?')
      .all(limit, offset);
    return reply.send(page(rows, limit, offset));
  });

  app.get<{ Params: { id: string } }>('/exports/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from export_jobs where id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'export job not found' });
    return reply.send(row);
  });

  // Runs the stored filter again and returns the rows inline (the real
  // deployment streams it to object storage; this is the local dev path).
  app.get<{ Params: { id: string } }>('/exports/:id/download', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const job: any = db.prepare('select * from export_jobs where id = ?').get(req.params.id);
    if (!job) return reply.status(404).send({ error: 'not_found', message: 'export job not found' });
    const filters: ExportFilters = JSON.parse(job.filters || '{}');
    const where: string[] = ['deleted_at is null'];
    const params: any[] = [];
    if (filters.tenantId) {
      where.push('tenant_id = ?');
      params.push(filters.tenantId);
    }
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
    const table = job.kind === 'projects' ? 'projects' : job.kind === 'comments' ? 'comments' : 'tasks';
    const rows = db.prepare(`select * from ${table} where ${where.join(' and ')}`).all(...params);
    return reply.send({ jobId: job.id, kind: job.kind, filters, rowCount: rows.length, rows });
  });

  /* ---------------------------------------------------------------- search */

  function searchAll(term: string, limit: number) {
    const like = `%${term}%`;
    return {
      projects: db.prepare('select * from projects where name like ? and deleted_at is null limit ?').all(like, limit),
      tasks: db.prepare('select * from tasks where title like ? and deleted_at is null limit ?').all(like, limit),
      comments: db.prepare('select * from comments where body like ? limit ?').all(like, limit),
      users: db.prepare('select id, name, email from users where name like ? or email like ? limit ?').all(like, like, limit),
    };
  }

  app.get<{ Querystring: { q?: string; limit?: string } }>('/search', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const q = (req.query?.q ?? '').trim();
    if (q.length < 2) return reply.status(400).send({ error: 'bad_request', message: 'q must be at least 2 chars' });
    const limit = parseLimit(req.query?.limit, 20);
    return reply.send({ q, ...searchAll(q, limit) });
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/search/tasks', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const q = (req.query?.q ?? '').trim();
    const limit = parseLimit(req.query?.limit, 20);
    return reply.send({ items: searchAll(q, limit).tasks });
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/search/projects', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const q = (req.query?.q ?? '').trim();
    const limit = parseLimit(req.query?.limit, 20);
    return reply.send({ items: searchAll(q, limit).projects });
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/search/users', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const q = (req.query?.q ?? '').trim();
    const limit = parseLimit(req.query?.limit, 20);
    return reply.send({ items: searchAll(q, limit).users });
  });

  /* --------------------------------------------------------------- reports */

  app.get('/reports/overview', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const cached = cacheGet<unknown>('reports:overview');
    if (cached) return reply.send({ ...(cached as object), cached: true });

    const projects: any = db.prepare('select count(*) as total from projects where deleted_at is null').get();
    const tasks: any = db.prepare('select count(*) as total from tasks where deleted_at is null').get();
    const done: any = db.prepare("select count(*) as total from tasks where status = 'done' and deleted_at is null").get();
    const overdue = db
      .prepare("select count(*) as total from tasks where status != 'done' and priority = 1 and deleted_at is null")
      .get();
    const payload = {
      projects: projects.total,
      tasks: tasks.total,
      done: done.total,
      urgentOpen: (overdue as any).total,
      completionRate: tasks.total ? Number((done.total / tasks.total).toFixed(3)) : 0,
    };
    cacheSet('reports:overview', payload);
    return reply.send({ ...payload, cached: false });
  });

  app.get('/reports/tasks-by-status', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const rows = db
      .prepare('select status, count(*) as total from tasks where deleted_at is null group by status order by total desc')
      .all();
    return reply.send({ items: rows });
  });

  app.get<{ Querystring: { limit?: string } }>('/reports/activity', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const limit = parseLimit(req.query?.limit, 50);
    const rows = db
      .prepare(
        `select a.*, u.name as actor_name
           from audit_logs a left join users u on u.id = a.actor_id
          order by a.created_at desc limit ?`,
      )
      .all(limit);
    return reply.send({ items: rows });
  });

  app.get('/reports/utilization', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const rows = db
      .prepare(
        `select u.id as user_id, u.name,
                count(t.id) as open_tasks,
                sum(case when t.status = 'done' then 1 else 0 end) as done_tasks
           from users u
           left join tasks t on t.assignee_id = u.id and t.deleted_at is null
          group by u.id
          order by open_tasks desc`,
      )
      .all();
    return reply.send({ items: rows });
  });

  app.get<{ Querystring: { format?: string; kind?: string } }>('/reports/export', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const kind = req.query?.kind ?? 'tasks';
    const table = kind === 'projects' ? 'projects' : 'tasks';
    const rows = db.prepare(`select * from ${table} where deleted_at is null order by created_at desc`).all();
    const format = req.query?.format === 'csv' ? 'csv' : 'json';
    if (format === 'csv') {
      const header = Object.keys(rows[0] ?? { id: '' }).join(',');
      const body = rows.map((r: any) => Object.values(r).map((v) => String(v ?? '')).join(',') ).join('\n');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .send(`${header}\n${body}`);
    }
    return reply.send({ kind, rowCount: rows.length, rows });
  });

  /* -------------------------------------------------------------- webhooks */

  app.get('/webhooks', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const rows = db.prepare('select * from webhooks order by created_at desc').all();
    return reply.send({ items: rows });
  });

  app.post<{ Body: { url: string; event?: string } }>('/webhooks', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
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
  });

  app.delete<{ Params: { id: string } }>('/webhooks/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from webhooks where id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'webhook not found' });
    db.prepare('delete from webhooks where id = ?').run(row.id);
    return reply.send({ ok: true });
  });
}
