import type { FastifyInstance } from 'fastify';
import { cacheStats } from '../cache.ts';

const VERSION = '1.4.0';
const REGIONS = ['cn-east-1', 'cn-north-1', 'ap-southeast-1'];

export default async function metaRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok', uptime: Math.round(process.uptime()) }));

  app.get('/meta/version', async () => ({
    version: VERSION,
    node: process.version,
    commit: process.env.GIT_COMMIT ?? 'dev',
  }));

  app.get('/meta/regions', async () => ({ items: REGIONS }));

  app.get('/meta/status', async () => {
    const db = app.db;
    const tenants: any = db.prepare('select count(*) as total from tenants').get();
    const users: any = db.prepare('select count(*) as total from users').get();
    return {
      status: 'operational',
      tenants: tenants.total,
      users: users.total,
      cache: cacheStats(),
      checkedAt: new Date().toISOString(),
    };
  });
}
