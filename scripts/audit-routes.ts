// Temporary audit helper (kept under scripts/, not shipped): verify that
// every non-public route carries a central authz preHandler.
import Fastify from 'fastify';
import { openDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { bearerToken, resolveSession } from '../src/auth.ts';

const PUBLIC = new Set(['/health', '/meta/version', '/meta/regions', '/meta/status', '/auth/login', '/auth/register']);

const db = openDb(':memory:');
seed(db);

const registered: Array<{ method: string; url: string; preHandler: unknown }> = [];
const app = Fastify();
app.decorate('db', db);
app.decorateRequest('ctx', null);
app.addHook('onRequest', async (req: any) => {
  const token = bearerToken(req.headers as Record<string, unknown>);
  req.ctx = token ? resolveSession(db, token) : null;
});
app.addHook('onRoute', (r: any) => {
  for (const method of Array.isArray(r.method) ? r.method : [r.method]) {
    if (method === 'HEAD') continue;
    registered.push({ method, url: r.url, preHandler: r.preHandler });
  }
});

await app.register((await import('../src/routes/auth.ts')).default);
await app.register((await import('../src/routes/org.ts')).default);
await app.register((await import('../src/routes/work.ts')).default);
await app.register((await import('../src/routes/insights.ts')).default);
await app.register((await import('../src/routes/admin.ts')).default);
await app.register((await import('../src/routes/meta.ts')).default);
await app.ready();

const problems: string[] = [];
for (const r of registered) {
  if (PUBLIC.has(r.url)) continue;
  const list = r.preHandler ? (Array.isArray(r.preHandler) ? r.preHandler : [r.preHandler]) : [];
  if (list.length === 0) problems.push(`no preHandler: ${r.method} ${r.url}`);
}
console.log(`audited ${registered.length} routes (${registered.filter((r) => !PUBLIC.has(r.url)).length} protected)`);
if (problems.length) {
  console.error('PROBLEMS:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('all non-public routes have a central authz preHandler');
await app.close();
