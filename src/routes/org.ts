import type { FastifyInstance } from 'fastify';
import { audit, newId, nowIso } from '../db.ts';
import { hashPassword } from '../auth.ts';
import { parseLimit, requireAdminCtx, requireCtx } from './helpers.ts';

export default async function orgRoutes(app: FastifyInstance) {
  const { db } = app;

  /* ---------------------------------------------------------------- tenants */

  app.get('/tenants', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const rows = db
      .prepare(
        `select t.*, m.role from tenants t
           join memberships m on m.tenant_id = t.id
          where m.user_id = ? and m.status = 'active'
          order by t.created_at asc`,
      )
      .all(ctx.userId);
    return reply.send({ items: rows });
  });

  app.get<{ Params: { id: string } }>('/tenants/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from tenants where id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'tenant not found' });
    return reply.send(row);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; plan?: string } }>(
    '/tenants/:id',
    async (req, reply) => {
      const ctx = requireAdminCtx(req, reply);
      if (!ctx) return;
      const current: any = db.prepare('select * from tenants where id = ?').get(req.params.id);
      if (!current) return reply.status(404).send({ error: 'not_found', message: 'tenant not found' });
      const next = {
        name: req.body?.name ?? current.name,
        plan: req.body?.plan ?? current.plan,
      };
      db.prepare('update tenants set name = ?, plan = ? where id = ?').run(next.name, next.plan, current.id);
      audit(db, ctx.tenantId, ctx.userId, 'tenant.update', current.id, next);
      return reply.send({ ...current, ...next });
    },
  );

  app.get<{ Params: { id: string } }>('/tenants/:id/stats', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const tenantId = req.params.id;
    const projects: any = db
      .prepare('select count(*) as total from projects where tenant_id = ? and deleted_at is null')
      .get(tenantId);
    const tasks: any = db
      .prepare('select count(*) as total from tasks where tenant_id = ? and deleted_at is null')
      .get(tenantId);
    const done: any = db
      .prepare("select count(*) as total from tasks where tenant_id = ? and status = 'done' and deleted_at is null")
      .get(tenantId);
    const members: any = db
      .prepare("select count(*) as total from memberships where tenant_id = ? and status = 'active'")
      .get(tenantId);
    return reply.send({
      tenantId,
      projects: projects.total,
      tasks: tasks.total,
      done: done.total,
      members: members.total,
      completionRate: tasks.total ? Number((done.total / tasks.total).toFixed(3)) : 0,
    });
  });

  app.get<{ Params: { id: string } }>('/tenants/:id/members', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const rows = db
      .prepare(
        `select m.id, m.role, m.status, u.id as user_id, u.name, u.email
           from memberships m join users u on u.id = m.user_id
          where m.tenant_id = ?
          order by m.created_at asc`,
      )
      .all(req.params.id);
    return reply.send({ items: rows });
  });

  /* ------------------------------------------------------------------ users */

  app.get<{ Querystring: { q?: string; limit?: string } }>('/users', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const limit = parseLimit(req.query?.limit);
    const rows = req.query?.q
      ? db
          .prepare('select id, email, name, created_at from users where name like ? or email like ? limit ?')
          .all(`%${req.query.q}%`, `%${req.query.q}%`, limit)
      : db.prepare('select id, email, name, created_at from users order by created_at asc limit ?').all(limit);
    return reply.send({ items: rows });
  });

  app.get<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db
      .prepare('select id, email, name, created_at from users where id = ?')
      .get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'user not found' });
    return reply.send(row);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; email?: string } }>(
    '/users/:id',
    async (req, reply) => {
      const ctx = requireCtx(req, reply);
      if (!ctx) return;
      const current: any = db.prepare('select * from users where id = ?').get(req.params.id);
      if (!current) return reply.status(404).send({ error: 'not_found', message: 'user not found' });
      const name = req.body?.name ?? current.name;
      const email = req.body?.email ?? current.email;
      db.prepare('update users set name = ?, email = ? where id = ?').run(name, email, current.id);
      audit(db, ctx.tenantId, ctx.userId, 'user.update', current.id, { name, email });
      return reply.send({ id: current.id, name, email });
    },
  );

  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const ctx = requireAdminCtx(req, reply);
    if (!ctx) return;
    const current: any = db.prepare('select * from users where id = ?').get(req.params.id);
    if (!current) return reply.status(404).send({ error: 'not_found', message: 'user not found' });
    db.prepare("update memberships set status = 'disabled' where user_id = ?").run(current.id);
    db.prepare('delete from sessions where user_id = ?').run(current.id);
    audit(db, ctx.tenantId, ctx.userId, 'user.disable', current.id);
    return reply.send({ ok: true });
  });

  app.get<{ Params: { id: string } }>('/users/:id/profile', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select * from users where id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'user not found' });
    const teams = db
      .prepare("select tenant_id, role from memberships where user_id = ? and status = 'active'")
      .all(row.id);
    return reply.send({
      id: row.id,
      name: row.name,
      email: row.email,
      createdAt: row.created_at,
      teams,
    });
  });

  app.get<{ Params: { id: string } }>('/users/:id/avatar', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const row: any = db.prepare('select name, email from users where id = ?').get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'user not found' });
    const initials = String(row.name)
      .split(/\s+/)
      .map((p: string) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    return reply.send({ userId: req.params.id, initials, email: row.email });
  });

  /* -------------------------------------------------------------- members */

  app.get<{ Querystring: { tenantId?: string } }>('/members', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const tenantId = req.query?.tenantId ?? ctx.tenantId;
    const rows = db
      .prepare(
        `select m.id, m.tenant_id, m.role, m.status, u.id as user_id, u.name, u.email
           from memberships m join users u on u.id = m.user_id
          where m.tenant_id = ?
          order by m.created_at asc`,
      )
      .all(tenantId);
    return reply.send({ items: rows });
  });

  app.post<{ Body: { tenantId?: string; email: string; name?: string; password?: string; role?: string } }>(
    '/members',
    async (req, reply) => {
      const ctx = requireAdminCtx(req, reply);
      if (!ctx) return;
      const { email, name, password, role } = req.body ?? ({} as any);
      const tenantId = req.body?.tenantId ?? ctx.tenantId;
      if (!email) return reply.status(400).send({ error: 'bad_request', message: 'email is required' });
      let user: any = db.prepare('select * from users where email = ?').get(email);
      if (!user) {
        const id = newId('u');
        db.prepare('insert into users (id, email, name, password_hash, created_at) values (?,?,?,?,?)').run(
          id,
          email,
          name ?? email.split('@')[0],
          hashPassword(password ?? 'changeme123'),
          nowIso(),
        );
        user = db.prepare('select * from users where id = ?').get(id);
      }
      const existing: any = db
        .prepare('select * from memberships where tenant_id = ? and user_id = ?')
        .get(tenantId, user.id);
      if (existing) {
        return reply.status(409).send({ error: 'conflict', message: 'user already a member' });
      }
      const id = newId('mb');
      db.prepare('insert into memberships (id, tenant_id, user_id, role, status, created_at) values (?,?,?,?,?,?)').run(
        id,
        tenantId,
        user.id,
        role ?? 'member',
        'active',
        nowIso(),
      );
      audit(db, ctx.tenantId, ctx.userId, 'member.add', user.id, { tenantId, role: role ?? 'member' });
      return reply.status(201).send({ id, tenantId, userId: user.id, role: role ?? 'member' });
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string; status?: string } }>(
    '/members/:id',
    async (req, reply) => {
      const ctx = requireAdminCtx(req, reply);
      if (!ctx) return;
      const current: any = db.prepare('select * from memberships where id = ?').get(req.params.id);
      if (!current) return reply.status(404).send({ error: 'not_found', message: 'membership not found' });
      const role = req.body?.role ?? current.role;
      const status = req.body?.status ?? current.status;
      db.prepare('update memberships set role = ?, status = ? where id = ?').run(role, status, current.id);
      audit(db, ctx.tenantId, ctx.userId, 'member.update', current.id, { role, status });
      return reply.send({ ...current, role, status });
    },
  );

  app.delete<{ Params: { id: string } }>('/members/:id', async (req, reply) => {
    const ctx = requireAdminCtx(req, reply);
    if (!ctx) return;
    const current: any = db.prepare('select * from memberships where id = ?').get(req.params.id);
    if (!current) return reply.status(404).send({ error: 'not_found', message: 'membership not found' });
    db.prepare('delete from memberships where id = ?').run(current.id);
    db.prepare('delete from sessions where user_id = ? and tenant_id = ?').run(current.user_id, current.tenant_id);
    audit(db, ctx.tenantId, ctx.userId, 'member.remove', current.id);
    return reply.send({ ok: true });
  });
}
