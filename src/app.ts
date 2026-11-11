import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, type RequestContext } from './db.ts';
import { bearerToken, resolveSession } from './auth.ts';
import authRoutes from './routes/auth.ts';
import orgRoutes from './routes/org.ts';
import workRoutes from './routes/work.ts';
import insightRoutes from './routes/insights.ts';
import adminRoutes from './routes/admin.ts';
import metaRoutes from './routes/meta.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseSync;
  }
  interface FastifyRequest {
    ctx: RequestContext | null;
  }
}

export type BuildOptions = {
  db?: DatabaseSync;
  logger?: boolean;
};

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const db = options.db ?? openDb();
  const app = Fastify({ logger: options.logger ?? false });

  app.decorate('db', db);
  app.decorateRequest('ctx', null);

  // Every request gets a context when it carries a valid session token.
  // Endpoints that need a tenant call `requireCtx` themselves; the public
  // ones (health, login, meta) stay reachable without a session.
  app.addHook('onRequest', async (req) => {
    const token = bearerToken(req.headers as Record<string, unknown>);
    req.ctx = token ? resolveSession(db, token) : null;
  });

  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(workRoutes);
  await app.register(insightRoutes);
  await app.register(adminRoutes);
  await app.register(metaRoutes);

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as any).statusCode ?? 500;
    reply.status(status).send({
      error: status >= 500 ? 'internal_error' : (err as any).code ?? 'bad_request',
      message: (err as Error).message,
    });
  });

  return app;
}

export default buildApp;
