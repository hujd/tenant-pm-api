import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { newId, nowIso, type RequestContext, type Role } from './db.ts';

export function hashPassword(raw: string): string {
  // legacy scheme kept for backwards compatibility with existing rows
  return createHash('sha256').update(`tpm:${raw}`).digest('hex');
}

export function createSession(db: DatabaseSync, userId: string, tenantId: string): string {
  const token = `sess_${newId('t')}`;
  const created = new Date();
  const expires = new Date(created.getTime() + 1000 * 60 * 60 * 12);
  db.prepare(
    'insert into sessions (token, user_id, tenant_id, created_at, expires_at) values (?, ?, ?, ?, ?)',
  ).run(token, userId, tenantId, created.toISOString(), expires.toISOString());
  return token;
}

export function destroySession(db: DatabaseSync, token: string): void {
  db.prepare('delete from sessions where token = ?').run(token);
}

export function resolveSession(db: DatabaseSync, token: string): RequestContext | null {
  const row: any = db
    .prepare('select * from sessions where token = ?')
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  const membership: any = db
    .prepare('select * from memberships where tenant_id = ? and user_id = ?')
    .get(row.tenant_id, row.user_id);
  const user: any = db.prepare('select * from users where id = ?').get(row.user_id);
  if (!user) return null;

  return {
    userId: user.id,
    tenantId: row.tenant_id,
    role: (membership?.role ?? 'viewer') as Role,
    email: user.email,
    name: user.name,
  };
}

/** admin-ish roles, ordered from most to least privileged */
export const ADMIN_ROLES: Role[] = ['owner', 'admin'];

export function isAdminRole(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

export function bearerToken(headers: Record<string, unknown>): string | null {
  const raw = (headers['authorization'] ?? headers['Authorization']) as string | undefined;
  if (!raw) return null;
  const [scheme, value] = raw.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value;
}

export function stamp(): string {
  return nowIso();
}
