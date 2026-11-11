import { openDb } from '../src/db.ts';
import { seed, type SeedResult } from '../src/seed.ts';
import { buildApp } from '../src/app.ts';
import type { FastifyInstance } from 'fastify';

export type Harness = {
  app: FastifyInstance;
  data: SeedResult;
  login: (email: string, password: string, tenantId?: string) => Promise<string>;
  as: (email: string) => Promise<{ authorization: string; 'x-role': string }>;
};

export async function makeHarness(): Promise<Harness> {
  const db = openDb(':memory:');
  const data = seed(db);
  const app = await buildApp({ db });
  await app.ready();

  const login = async (email: string, password: string, tenantId?: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password, tenantId },
    });
    if (res.statusCode !== 200) {
      throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
    }
    return res.json().token as string;
  };

  const as = async (email: string) => {
    const person = data.users[email];
    if (!person) throw new Error(`unknown seed user ${email}`);
    const token = await login(email, person.password, person.tenantId);
    return { authorization: `Bearer ${token}`, 'x-role': person.role } as const;
  };

  return { app, data, login, as };
}
