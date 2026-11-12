/**
 * Centralized authorization layer.
 *
 * All authentication / role / tenant-isolation decisions for HTTP routes live
 * here. Route handlers never invent their own permission checks: they either
 * register one of the preHandler hooks (`requireSession`, `requireWriter`,
 * `requireAdmin`) or call one of the resource helpers below before touching a
 * row. This is the single place that knows what "member of the same tenant"
 * and "admin role" mean.
 *
 * Status code convention:
 *  - 401: no valid session
 *  - 403: authenticated, but the role is not allowed to perform the action
 *  - 404: resource does not exist *or* belongs to another tenant. We never
 *    reveal the existence of another tenant's rows, so an id swap attack gets
 *    the same response as a random id.
 */
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestContext, Role } from './db.ts';
import { isAdminRole } from './auth.ts';

/* ------------------------------------------------------------- HTTP errors */

export class HttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'insufficient permissions') =>
  new HttpError(403, 'forbidden', message);
export const unauthorized = () =>
  new HttpError(401, 'unauthorized', 'missing or expired session');

/* --------------------------------------------------------- role / RBAC map */

export type AuthzAction = 'read' | 'write' | 'admin';

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/** Pure role policy — the only place role hierarchy is encoded. */
export function roleAllows(role: Role, action: AuthzAction): boolean {
  if (action === 'read') return true; // any authenticated member may read
  if (action === 'write') return ROLE_RANK[role] >= ROLE_RANK.member;
  return isAdminRole(role); // admin action: owner/admin only
}

function ctxFromRequest(req: FastifyRequest): RequestContext {
  if (!req.ctx) throw unauthorized();
  return req.ctx;
}

/* ------------------------------------------------------- preHandler hooks */

export const requireSession: preHandlerHookHandler = async (req) => {
  ctxFromRequest(req);
};

export const requireWriter: preHandlerHookHandler = async (req) => {
  const ctx = ctxFromRequest(req);
  if (!roleAllows(ctx.role, 'write')) {
    throw forbidden('write access requires member role or higher');
  }
};

export const requireAdmin: preHandlerHookHandler = async (req) => {
  const ctx = ctxFromRequest(req);
  if (!roleAllows(ctx.role, 'admin')) {
    throw forbidden('admin role required');
  }
};

/* ------------------------------------------------- tenant resource registry */

type TenantResourceSpec = {
  table: string;
  /** column holding the tenant id; every scoped table has tenant_id */
  tenantColumn?: string;
  /** table also has the soft-delete column */
  softDelete?: boolean;
};

/**
 * Every table that stores tenant-owned rows. Keeping this in one registry
 * means a new resource cannot accidentally be added without a tenant check.
 */
export const TENANT_RESOURCES: Record<string, TenantResourceSpec> = {
  tenant: { table: 'tenants', tenantColumn: 'id' },
  project: { table: 'projects', softDelete: true },
  task: { table: 'tasks', softDelete: true },
  comment: { table: 'comments' },
  attachment: { table: 'attachments' },
  exportJob: { table: 'export_jobs' },
  webhook: { table: 'webhooks' },
  membership: { table: 'memberships' },
};

export type TenantResourceKind = string;

function loadRow(db: DatabaseSync, kind: TenantResourceKind, id: string): any | undefined {
  const spec = TENANT_RESOURCES[kind];
  if (!spec) throw new Error(`unknown tenant resource kind: ${kind}`);
  const sql = `select * from ${spec.table} where id = ?${spec.softDelete ? ' and deleted_at is null' : ''}`;
  return db.prepare(sql).get(id) as any | undefined;
}

/**
 * Load a tenant-owned row and assert it belongs to the caller's tenant.
 * Throws 404 both when the row is missing and when it belongs to another
 * tenant, so the response cannot be used to probe foreign ids.
 */
export function requireOwnedResource(
  db: DatabaseSync,
  ctx: RequestContext,
  kind: TenantResourceKind,
  id: string,
  label?: string,
): any {
  const row = loadRow(db, kind, id);
  const spec = TENANT_RESOURCES[kind];
  const tenantColumn = spec.tenantColumn ?? 'tenant_id';
  if (!row || row[tenantColumn] !== ctx.tenantId) {
    throw notFound(label ?? kind);
  }
  return row;
}

/**
 * Batch variant: every id must resolve to a live row in the caller's tenant.
 * Returns the loaded rows so handlers do not have to re-query.
 */
export function requireOwnedResources(
  db: DatabaseSync,
  ctx: RequestContext,
  kind: TenantResourceKind,
  ids: string[],
  label?: string,
): any[] {
  return ids.map((id) => requireOwnedResource(db, ctx, kind, id, label));
}

/* ------------------------------------------------------------ user scoping */

/**
 * Users are global rows (no tenant_id column); access is mediated by an
 * active membership in the caller's tenant. Returns false for unknown users
 * and users who only belong to other workspaces — handlers turn that into 404.
 */
export function requireTenantUser(db: DatabaseSync, ctx: RequestContext, userId: string): any {
  const user = db.prepare('select id, email, name, created_at from users where id = ?').get(userId);
  const member = user
    ? db
        .prepare(
          "select 1 from memberships where tenant_id = ? and user_id = ? and status = 'active' limit 1",
        )
        .get(ctx.tenantId, userId)
    : undefined;
  if (!member) throw notFound('user');
  return user;
}

/* ------------------------------------------------ ownership-style mutations */

/**
 * Comments/attachments are tenant-readable but mutating them is restricted to
 * the author or a tenant admin. Cross-tenant callers never get this far (the
 * row lookup already 404s).
 */
export function requireActorOrAdmin(
  ctx: RequestContext,
  row: { user_id?: string },
  message = 'only the author or a workspace admin may modify this resource',
): void {
  if (isAdminRole(ctx.role) || row.user_id === ctx.userId) return;
  throw forbidden(message);
}
