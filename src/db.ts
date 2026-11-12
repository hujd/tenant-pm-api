import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export type RequestContext = {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  name: string;
};

const SCHEMA = `
create table if not exists tenants (
  id          text primary key,
  name        text not null,
  plan        text not null default 'team',
  created_at  text not null
);

create table if not exists users (
  id            text primary key,
  email         text not null unique,
  name          text not null,
  password_hash text not null,
  created_at    text not null
);

create table if not exists memberships (
  id         text primary key,
  tenant_id  text not null,
  user_id    text not null,
  role       text not null check (role in ('owner','admin','member','viewer')),
  status     text not null default 'active',
  created_at text not null,
  unique (tenant_id, user_id)
);

create table if not exists sessions (
  token      text primary key,
  user_id    text not null,
  tenant_id  text not null,
  created_at text not null,
  expires_at text not null
);

create table if not exists projects (
  id         text primary key,
  tenant_id  text not null,
  name       text not null,
  status     text not null default 'active',
  owner_id   text,
  created_at text not null,
  deleted_at text
);

create table if not exists tasks (
  id          text primary key,
  tenant_id   text not null,
  project_id  text not null,
  title       text not null,
  status      text not null default 'todo',
  assignee_id text,
  priority    integer not null default 2,
  created_at  text not null,
  deleted_at  text
);

create table if not exists comments (
  id         text primary key,
  tenant_id  text not null,
  task_id    text not null,
  user_id    text not null,
  body       text not null,
  created_at text not null
);

create table if not exists attachments (
  id          text primary key,
  tenant_id   text not null,
  task_id     text not null,
  filename    text not null,
  size        integer not null,
  storage_key text not null,
  created_at  text not null
);

create table if not exists export_jobs (
  id         text primary key,
  tenant_id  text not null,
  user_id    text not null,
  kind       text not null,
  filters    text not null,
  status     text not null default 'queued',
  created_at text not null
);

create table if not exists audit_logs (
  id         text primary key,
  tenant_id  text not null,
  actor_id   text,
  action     text not null,
  target     text,
  meta       text,
  created_at text not null
);

create table if not exists webhooks (
  id         text primary key,
  tenant_id  text not null,
  url        text not null,
  event      text not null,
  created_at text not null
);

create table if not exists settings (
  tenant_id text not null,
  key       text not null,
  value     text not null,
  primary key (tenant_id, key)
);

create index if not exists idx_projects_tenant   on projects (tenant_id);
create index if not exists idx_tasks_tenant      on tasks (tenant_id);
create index if not exists idx_tasks_project     on tasks (project_id);
create index if not exists idx_comments_task     on comments (task_id);
create index if not exists idx_attachments_task  on attachments (task_id);
create index if not exists idx_memberships_user  on memberships (user_id);
create index if not exists idx_audit_tenant      on audit_logs (tenant_id, created_at);

-- Authorization lookups added during the multi-tenant isolation remediation.
-- Indexes only: no table/column changes, safe to apply to live databases.
create index if not exists idx_memberships_tenant_user on memberships (tenant_id, user_id, status);
create index if not exists idx_comments_tenant         on comments (tenant_id);
create index if not exists idx_attachments_tenant      on attachments (tenant_id);
create index if not exists idx_export_jobs_tenant      on export_jobs (tenant_id);
create index if not exists idx_webhooks_tenant         on webhooks (tenant_id);
create index if not exists idx_tasks_tenant_project    on tasks (tenant_id, project_id);
create index if not exists idx_projects_tenant_active  on projects (tenant_id, deleted_at);
create index if not exists idx_sessions_user_tenant    on sessions (user_id, tenant_id);
`;

export function openDb(file?: string): DatabaseSync {
  const target = file ?? process.env.DB_FILE ?? path.join(process.cwd(), 'data', 'app.db');
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new DatabaseSync(target);
  db.exec('pragma foreign_keys = on;');
  db.exec(SCHEMA);
  return db;
}

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function audit(
  db: DatabaseSync,
  tenantId: string,
  actorId: string | null,
  action: string,
  target: string | null,
  meta: Record<string, unknown> = {},
): void {
  db.prepare(
    'insert into audit_logs (id, tenant_id, actor_id, action, target, meta, created_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(newId('al'), tenantId, actorId, action, target, JSON.stringify(meta), nowIso());
}
