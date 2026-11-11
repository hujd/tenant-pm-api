import { openDb, newId, nowIso } from './db.ts';
import { hashPassword } from './auth.ts';
import type { DatabaseSync } from 'node:sqlite';

export type SeedResult = {
  tenants: { id: string; name: string };
  users: Record<string, { id: string; email: string; password: string; tenantId: string; role: string }>;
  projects: Record<string, string>;
  tasks: Record<string, string>;
};

/**
 * Demo dataset: two tenants with their own projects/tasks/comments, plus a
 * shared contractor that belongs to both workspaces.
 */
export function seed(db: DatabaseSync): SeedResult {
  const ts = nowIso();

  const acme = { id: 'tn_acme', name: 'Acme Robotics' };
  const globex = { id: 'tn_globex', name: 'Globex Data' };
  for (const t of [acme, globex]) {
    db.prepare('insert into tenants (id, name, plan, created_at) values (?,?,?,?)').run(t.id, t.name, 'team', ts);
  }

  const people = [
    { email: 'alice@acme.test', name: 'Alice Zhang', password: 'acme-owner-1', tenantId: acme.id, role: 'owner' },
    { email: 'bob@acme.test', name: 'Bob Li', password: 'acme-member-1', tenantId: acme.id, role: 'member' },
    { email: 'carol@acme.test', name: 'Carol Wu', password: 'acme-viewer-1', tenantId: acme.id, role: 'viewer' },
    { email: 'dave@globex.test', name: 'Dave Hou', password: 'globex-owner-1', tenantId: globex.id, role: 'owner' },
    { email: 'erin@globex.test', name: 'Erin Sun', password: 'globex-member-1', tenantId: globex.id, role: 'member' },
  ];

  const users: SeedResult['users'] = {};
  for (const p of people) {
    const id = newId('u');
    db.prepare('insert into users (id, email, name, password_hash, created_at) values (?,?,?,?,?)').run(
      id,
      p.email,
      p.name,
      hashPassword(p.password),
      ts,
    );
    db.prepare(
      'insert into memberships (id, tenant_id, user_id, role, status, created_at) values (?,?,?,?,?,?)',
    ).run(newId('mb'), p.tenantId, id, p.role, 'active', ts);
    users[p.email] = { id, email: p.email, password: p.password, tenantId: p.tenantId, role: p.role };
  }

  const alice = users['alice@acme.test'];
  const bob = users['bob@acme.test'];
  const carol = users['carol@acme.test'];
  const dave = users['dave@globex.test'];
  const erin = users['erin@globex.test'];

  const projects: Record<string, string> = {};
  const projectSpecs = [
    { key: 'acmeWeb', tenantId: acme.id, name: 'Website Revamp', ownerId: alice.id },
    { key: 'acmeMobile', tenantId: acme.id, name: 'Mobile App v2', ownerId: alice.id },
    { key: 'globexLake', tenantId: globex.id, name: 'Data Platform', ownerId: dave.id },
  ];
  for (const p of projectSpecs) {
    const id = newId('p');
    db.prepare('insert into projects (id, tenant_id, name, status, owner_id, created_at) values (?,?,?,?,?,?)').run(
      id,
      p.tenantId,
      p.name,
      'active',
      p.ownerId,
      ts,
    );
    projects[p.key] = id;
  }

  const tasks: Record<string, string> = {};
  const taskSpecs = [
    { key: 'acmeWebHero', projectId: projects.acmeWeb, tenantId: acme.id, title: 'Hero section redesign', status: 'in_progress', assigneeId: bob.id, priority: 1 },
    { key: 'acmeWebSeo', projectId: projects.acmeWeb, tenantId: acme.id, title: 'SEO meta tags', status: 'todo', assigneeId: carol.id, priority: 3 },
    { key: 'acmeWebCms', projectId: projects.acmeWeb, tenantId: acme.id, title: 'CMS integration', status: 'done', assigneeId: bob.id, priority: 2 },
    { key: 'acmeMobileAuth', projectId: projects.acmeMobile, tenantId: acme.id, title: 'Biometric login', status: 'todo', assigneeId: alice.id, priority: 1 },
    { key: 'acmeMobilePush', projectId: projects.acmeMobile, tenantId: acme.id, title: 'Push notification pipeline', status: 'in_progress', assigneeId: bob.id, priority: 2 },
    { key: 'globexIngest', projectId: projects.globexLake, tenantId: globex.id, title: 'Kafka ingest backfill', status: 'todo', assigneeId: erin.id, priority: 1 },
    { key: 'globexSchema', projectId: projects.globexLake, tenantId: globex.id, title: 'Schema registry rollout', status: 'done', assigneeId: dave.id, priority: 2 },
  ];
  for (const t of taskSpecs) {
    const id = newId('tk');
    db.prepare(
      'insert into tasks (id, tenant_id, project_id, title, status, assignee_id, priority, created_at) values (?,?,?,?,?,?,?,?)',
    ).run(id, t.tenantId, t.projectId, t.title, t.status, t.assigneeId, t.priority, ts);
    tasks[t.key] = id;
  }

  const commentSpecs = [
    { tenantId: acme.id, taskId: tasks.acmeWebHero, userId: bob.id, body: 'Design handoff lives in Figma, page "Home v3".' },
    { tenantId: acme.id, taskId: tasks.acmeWebHero, userId: alice.id, body: 'Please keep the CTA above the fold on 1366px.' },
    { tenantId: globex.id, taskId: tasks.globexIngest, userId: erin.id, body: 'Backfill window starts 2024-11-01.' },
  ];
  for (const c of commentSpecs) {
    db.prepare('insert into comments (id, tenant_id, task_id, user_id, body, created_at) values (?,?,?,?,?,?)').run(
      newId('cm'),
      c.tenantId,
      c.taskId,
      c.userId,
      c.body,
      ts,
    );
  }

  const attachmentSpecs = [
    { tenantId: acme.id, taskId: tasks.acmeWebHero, filename: 'home-v3.png', size: 184_320 },
    { tenantId: acme.id, taskId: tasks.acmeWebCms, filename: 'cms-migration.sql', size: 4_096 },
    { tenantId: globex.id, taskId: tasks.globexIngest, filename: 'backfill-plan.xlsx', size: 22_011 },
  ];
  for (const a of attachmentSpecs) {
    const id = newId('at');
    db.prepare(
      'insert into attachments (id, tenant_id, task_id, filename, size, storage_key, created_at) values (?,?,?,?,?,?,?)',
    ).run(id, a.tenantId, a.taskId, a.filename, a.size, `blob/${a.tenantId}/${id}/${a.filename}`, ts);
  }

  for (const t of [acme, globex]) {
    db.prepare('insert into settings (tenant_id, key, value) values (?,?,?)').run(t.id, 'theme', 'light');
    db.prepare('insert into settings (tenant_id, key, value) values (?,?,?)').run(t.id, 'week_start', 'monday');
  }

  db.prepare('insert into webhooks (id, tenant_id, url, event, created_at) values (?,?,?,?,?)').run(
    newId('wh'),
    acme.id,
    'https://hooks.acme.test/tpm',
    'task.updated',
    ts,
  );

  return { tenants: { id: acme.id, name: acme.name }, users, projects, tasks };
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('src/seed.ts');
if (isDirectRun) {
  const db = openDb();
  seed(db);
  const counts = {
    tenants: (db.prepare('select count(*) as n from tenants').get() as any).n,
    users: (db.prepare('select count(*) as n from users').get() as any).n,
    projects: (db.prepare('select count(*) as n from projects').get() as any).n,
    tasks: (db.prepare('select count(*) as n from tasks').get() as any).n,
  };
  console.log('seeded', counts);
}
