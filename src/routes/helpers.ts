import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RequestContext } from '../db.ts';
import { isAdminRole } from '../auth.ts';

export function requireCtx(req: FastifyRequest, reply: FastifyReply): RequestContext | null {
  if (!req.ctx) {
    reply.status(401).send({ error: 'unauthorized', message: 'missing or expired session' });
    return null;
  }
  return req.ctx;
}

export function requireAdminCtx(req: FastifyRequest, reply: FastifyReply): RequestContext | null {
  const ctx = requireCtx(req, reply);
  if (!ctx) return null;
  if (!isAdminRole(ctx.role)) {
    reply.status(403).send({ error: 'forbidden', message: 'admin role required' });
    return null;
  }
  return ctx;
}

export function parseLimit(raw: unknown, fallback = 50, max = 200): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function parseCursor(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function page<T>(rows: T[], limit: number, offset: number): { items: T[]; next: number | null } {
  return {
    items: rows,
    next: rows.length === limit ? offset + limit : null,
  };
}
