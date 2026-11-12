import type { FastifyInstance } from 'fastify';
import { audit, nowIso } from '../db.ts';
import { parseLimit } from './helpers.ts';
import { notFound, requireAdmin, requireTenantUser } from '../authz.ts';

/**
 * Admin console routes.
 *
 * The previous implementation trusted a client-supplied `x-role` header, so
 * any authenticated user could elevate themselves to admin by simply sending
 * `x-role: admin`. The header is now ignored entirely: authorization is based
 * solely on the role attached to the server-side session, enforced centrally
 * by the `requireAdmin` preHandler hook. Every query is additionally scoped
 * to the caller's own tenant — a tenant admin has no cross-tenant powers.
 */
export default async function adminRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get<{ Querystring: { limit?: string } }>(
    '/admin/users',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ctx = req.ctx!;
      const limit = parseLimit(req.query?.limit, 100);
      const rows = db
        .prepare(
          `select u.id, u.email, u.name, u.created_at,
                  group_concat(m.tenant_id) as tenant_ids,
                  group_concat(m.role) as roles,
                  group_concat(m.status) as statuses
             from users u
             join memberships m on m.user_id = u.id
            where m.tenant_id = ?
            group by u.id order by u.created_at desc limit ?`,
        )
        .all(ctx.tenantId, limit);
      return reply.send({ items: rows });
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/admin/users/:id/suspend',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ctx = req.ctx!;
      // Only members of the caller's own workspace can be suspended.
      requireTenantUser(db, ctx, req.params.id);
      const user: any = db.prepare('select * from users where id = ?').get(req.params.id);
      db.prepare("update memberships set status = 'suspended' where tenant_id = ? and user_id = ?").run(
        ctx.tenantId,
        user.id,
      );
      db.prepare('delete from sessions where user_id = ? and tenant_id = ?').run(user.id, ctx.tenantId);
      audit(db, ctx.tenantId, ctx.userId, 'admin.user.suspend', user.id, {
        reason: req.body?.reason ?? null,
      });
      return reply.send({ ok: true, userId: user.id, status: 'suspended' });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/users/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ctx = req.ctx!;
      requireTenantUser(db, ctx, req.params.id);
      const user: any = db.prepare('select * from users where id = ?').get(req.params.id);
      // Remove only the membership in the caller's tenant; the user keeps
      // accounts in any other workspace they belong to.
      db.prepare('delete from memberships where tenant_id = ? and user_id = ?').run(ctx.tenantId, user.id);
      db.prepare('delete from sessions where user_id = ? and tenant_id = ?').run(user.id, ctx.tenantId);
      audit(db, ctx.tenantId, ctx.userId, 'admin.user.delete', user.id);
      return reply.send({ ok: true });
    },
  );

  app.get<{ Querystring: { limit?: string; tenantId?: string } }>(
    '/admin/audit-logs',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ctx = req.ctx!;
      const limit = parseLimit(req.query?.limit, 100);
      // A tenantId filter can only name the caller's own tenant.
      if (req.query?.tenantId && req.query.tenantId !== ctx.tenantId) {
        throw notFound('tenant');
      }
      const rows = db
        .prepare('select * from audit_logs where tenant_id = ? order by created_at desc limit ?')
        .all(ctx.tenantId, limit);
      return reply.send({ items: rows });
    },
  );

  app.get<{ Querystring: { tenantId?: string } }>(
    '/admin/settings',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ctx = req.ctx!;
      if (req.query?.tenantId && req.query.tenantId !== ctx.tenantId) {
        throw notFound('tenant');
      }
      const rows = db
        .prepare('select key, value from settings where tenant_id = ? order by key asc')
        .all(ctx.tenantId);
      return reply.send({ tenantId: ctx.tenantId, settings: rows });
    },
  );

  app.patch<{ Body: { key: string; value: string; tenantId?: string } }>(
    '/admin/settings',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { key, value } = req.body ?? ({} as any);
      if (!key) return reply.status(400).send({ error: 'bad_request', message: 'key is required' });
      if (req.body?.tenantId && req.body.tenantId !== ctx.tenantId) {
        return reply.status(403).send({ error: 'forbidden', message: 'cannot manage another workspace' });
      }
      const tenantId = ctx.tenantId;
      db.prepare(
        'insert into settings (tenant_id, key, value) values (?,?,?) on conflict(tenant_id, key) do update set value = excluded.value',
      ).run(tenantId, key, String(value ?? ''));
      audit(db, ctx.tenantId, ctx.userId, 'admin.settings.update', key, { tenantId });
      return reply.send({ ok: true, tenantId, key, value: String(value ?? ''), updatedAt: nowIso() });
    },
  );

  app.get('/admin/tenants', { preHandler: requireAdmin }, async (req, reply) => {
    const ctx = req.ctx!;
    // Tenant admins only see their own workspace row.
    const rows = db
      .prepare(
        `select t.id, t.name, t.plan, t.created_at,
                (select count(*) from memberships m where m.tenant_id = t.id) as members,
                (select count(*) from projects p where p.tenant_id = t.id) as projects
           from tenants t where t.id = ? order by t.created_at desc`,
      )
      .all(ctx.tenantId);
    return reply.send({ items: rows });
  });
}
