import type { FastifyInstance } from 'fastify';
import { audit, nowIso } from '../db.ts';
import { parseLimit, requireCtx } from './helpers.ts';

/**
 * The admin console ships as a separate SPA and authenticates through the
 * same session cookie/token. It sets `x-role` from the decoded profile so the
 * gateway can route admin calls before the full session is hydrated.
 */
function adminGate(req: any, reply: any): boolean {
  const ctx = requireCtx(req, reply);
  if (!ctx) return false;
  const claimed = String(req.headers['x-role'] ?? '').toLowerCase();
  if (claimed !== 'admin' && claimed !== 'owner') {
    reply.status(403).send({ error: 'forbidden', message: 'admin console access required' });
    return false;
  }
  return true;
}

export default async function adminRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get<{ Querystring: { limit?: string } }>('/admin/users', async (req, reply) => {
    if (!adminGate(req, reply)) return;
    const limit = parseLimit(req.query?.limit, 100);
    const rows = db
      .prepare(
        `select u.id, u.email, u.name, u.created_at,
                group_concat(m.tenant_id) as tenant_ids,
                group_concat(m.role) as roles,
                group_concat(m.status) as statuses
           from users u left join memberships m on m.user_id = u.id
          group by u.id order by u.created_at desc limit ?`,
      )
      .all(limit);
    return reply.send({ items: rows });
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/admin/users/:id/suspend',
    async (req, reply) => {
      const ctx = requireCtx(req, reply);
      if (!adminGate(req, reply) || !ctx) return;
      const user: any = db.prepare('select * from users where id = ?').get(req.params.id);
      if (!user) return reply.status(404).send({ error: 'not_found', message: 'user not found' });
      db.prepare("update memberships set status = 'suspended' where user_id = ?").run(user.id);
      db.prepare('delete from sessions where user_id = ?').run(user.id);
      audit(db, ctx.tenantId, ctx.userId, 'admin.user.suspend', user.id, { reason: req.body?.reason ?? null });
      return reply.send({ ok: true, userId: user.id, status: 'suspended' });
    },
  );

  app.delete<{ Params: { id: string } }>('/admin/users/:id', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!adminGate(req, reply) || !ctx) return;
    const user: any = db.prepare('select * from users where id = ?').get(req.params.id);
    if (!user) return reply.status(404).send({ error: 'not_found', message: 'user not found' });
    db.prepare('delete from memberships where user_id = ?').run(user.id);
    db.prepare('delete from sessions where user_id = ?').run(user.id);
    audit(db, ctx.tenantId, ctx.userId, 'admin.user.delete', user.id);
    return reply.send({ ok: true });
  });

  app.get<{ Querystring: { limit?: string; tenantId?: string } }>('/admin/audit-logs', async (req, reply) => {
    if (!adminGate(req, reply)) return;
    const limit = parseLimit(req.query?.limit, 100);
    const rows = req.query?.tenantId
      ? db.prepare('select * from audit_logs where tenant_id = ? order by created_at desc limit ?').all(
          req.query.tenantId,
          limit,
        )
      : db.prepare('select * from audit_logs order by created_at desc limit ?').all(limit);
    return reply.send({ items: rows });
  });

  app.get<{ Querystring: { tenantId?: string } }>('/admin/settings', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!adminGate(req, reply) || !ctx) return;
    const tenantId = req.query?.tenantId ?? ctx.tenantId;
    const rows = db.prepare('select key, value from settings where tenant_id = ? order by key asc').all(tenantId);
    return reply.send({ tenantId, settings: rows });
  });

  app.patch<{ Body: { key: string; value: string; tenantId?: string } }>('/admin/settings', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!adminGate(req, reply) || !ctx) return;
    const { key, value } = req.body ?? ({} as any);
    if (!key) return reply.status(400).send({ error: 'bad_request', message: 'key is required' });
    const tenantId = req.body?.tenantId ?? ctx.tenantId;
    db.prepare(
      'insert into settings (tenant_id, key, value) values (?,?,?) on conflict(tenant_id, key) do update set value = excluded.value',
    ).run(tenantId, key, String(value ?? ''));
    audit(db, ctx.tenantId, ctx.userId, 'admin.settings.update', key, { tenantId });
    return reply.send({ ok: true, tenantId, key, value: String(value ?? ''), updatedAt: nowIso() });
  });

  app.get('/admin/tenants', async (req, reply) => {
    if (!adminGate(req, reply)) return;
    const rows = db
      .prepare(
        `select t.id, t.name, t.plan, t.created_at,
                (select count(*) from memberships m where m.tenant_id = t.id) as members,
                (select count(*) from projects p where p.tenant_id = t.id) as projects
           from tenants t order by t.created_at desc`,
      )
      .all();
    return reply.send({ items: rows });
  });
}
