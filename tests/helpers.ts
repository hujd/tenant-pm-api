import { openDb } from '../src/db.ts';
import { seed, type SeedResult } from '../src/seed.ts';
import { buildApp } from '../src/app.ts';
import type { FastifyInstance } from 'fastify';

export type Harness = {
  app: FastifyInstance;
  data: SeedResult;
  login: (email: string, password: string, tenantId?: string) => Promise<string>;
  /** Legacy header set — includes the (now ignored) x-role claim. */
  as: (email: string) => Promise<{ authorization: string; 'x-role': string }>;
  /** Real client headers: only the bearer token, nothing the client could fake. */
  auth: (email: string) => Promise<{ authorization: string }>;
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

  const tokenFor = async (email: string): Promise<string> => {
    const person = data.users[email];
    if (!person) throw new Error(`unknown seed user ${email}`);
    return login(email, person.password, person.tenantId);
  };

  const as = async (email: string) => {
    const person = data.users[email];
    const token = await tokenFor(email);
    return { authorization: `Bearer ${token}`, 'x-role': person.role } as const;
  };

  const auth = async (email: string) => ({ authorization: `Bearer ${await tokenFor(email)}` });

  return { app, data, login, as, auth };
}
