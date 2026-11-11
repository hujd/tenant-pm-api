import type { FastifyInstance } from 'fastify';
import { newId, nowIso, audit } from '../db.ts';
import { createSession, destroySession, hashPassword } from '../auth.ts';
import { requireCtx } from './helpers.ts';

type LoginBody = { email: string; password: string; tenantId?: string };

export default async function authRoutes(app: FastifyInstance) {
  const { db } = app;

  // POST /auth/login — password login, picks the first active membership
  // unless the caller names a tenant explicitly.
  app.post<{ Body: LoginBody }>('/auth/login', async (req, reply) => {
    const { email, password, tenantId } = req.body ?? ({} as LoginBody);
    if (!email || !password) {
      return reply.status(400).send({ error: 'bad_request', message: 'email and password are required' });
    }
    const user: any = db.prepare('select * from users where email = ?').get(email);
    if (!user || user.password_hash !== hashPassword(password)) {
      return reply.status(401).send({ error: 'unauthorized', message: 'invalid credentials' });
    }
    const memberships: any[] = db
      .prepare("select * from memberships where user_id = ? and status = 'active' order by created_at asc")
      .all(user.id);
    if (memberships.length === 0) {
      return reply.status(403).send({ error: 'forbidden', message: 'user has no active workspace' });
    }
    const picked = tenantId
      ? memberships.find((m) => m.tenant_id === tenantId)
      : memberships[0];
    if (!picked) {
      return reply.status(403).send({ error: 'forbidden', message: 'not a member of that workspace' });
    }
    const token = createSession(db, user.id, picked.tenant_id);
    audit(db, picked.tenant_id, user.id, 'auth.login', user.id, { tenantId: picked.tenant_id });
    return reply.send({
      token,
      user: { id: user.id, email: user.email, name: user.name },
      tenantId: picked.tenant_id,
      role: picked.role,
    });
  });

  // POST /auth/register — self-serve signup, always creates a fresh workspace
  // with the caller as owner.
  app.post<{ Body: { email: string; password: string; name: string; tenantName: string } }>(
    '/auth/register',
    async (req, reply) => {
      const { email, password, name, tenantName } = req.body ?? ({} as any);
      if (!email || !password || !name || !tenantName) {
        return reply
          .status(400)
          .send({ error: 'bad_request', message: 'email, password, name and tenantName are required' });
      }
      const existing: any = db.prepare('select id from users where email = ?').get(email);
      if (existing) {
        return reply.status(409).send({ error: 'conflict', message: 'email already registered' });
      }
      const userId = newId('u');
      const tenantId = newId('tn');
      const ts = nowIso();
      db.prepare('insert into users (id, email, name, password_hash, created_at) values (?,?,?,?,?)').run(
        userId,
        email,
        name,
        hashPassword(password),
        ts,
      );
      db.prepare('insert into tenants (id, name, plan, created_at) values (?,?,?,?)').run(
        tenantId,
        tenantName,
        'team',
        ts,
      );
      db.prepare('insert into memberships (id, tenant_id, user_id, role, status, created_at) values (?,?,?,?,?,?)').run(
        newId('mb'),
        tenantId,
        userId,
        'owner',
        'active',
        ts,
      );
      const token = createSession(db, userId, tenantId);
      return reply.status(201).send({ token, tenantId, userId });
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const header = String(req.headers['authorization'] ?? '');
    destroySession(db, header.replace(/^Bearer\s+/i, ''));
    audit(db, ctx.tenantId, ctx.userId, 'auth.logout', ctx.userId);
    return reply.send({ ok: true });
  });

  app.get('/auth/me', async (req, reply) => {
    const ctx = requireCtx(req, reply);
    if (!ctx) return;
    const tenant: any = db.prepare('select * from tenants where id = ?').get(ctx.tenantId);
    return reply.send({
      user: { id: ctx.userId, email: ctx.email, name: ctx.name },
      tenant: tenant ? { id: tenant.id, name: tenant.name, plan: tenant.plan } : null,
      role: ctx.role,
    });
  });
}
