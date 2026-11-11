# tenant-pm-api

Multi-tenant project management API. One deployment serves many customer
workspaces ("tenants"); every table carries `tenant_id` and users reach a
workspace through a `membership` row that also holds their role
(`owner` / `admin` / `member` / `viewer`).

- runtime: Node.js >= 24 (runs TypeScript natively, uses the built-in `node:sqlite`), Fastify 5
- storage: SQLite file at `data/app.db` (override with `DB_FILE`)
- tests: `node --test`, full HTTP round-trips through `app.inject`, in-memory DB per suite

## Getting started

```bash
npm ci                # or: npm install --ignore-scripts
npm run seed          # create data/app.db and load the demo dataset
npm start             # http://localhost:3000
```

Every request authenticates with `Authorization: Bearer <session token>`.
`POST /auth/login` returns the token:

```bash
curl -s localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"alice@acme.test","password":"acme-owner-1"}'
```

Seeded accounts (all passwords are `<tenant>-<role>-1`):

| email | workspace | role |
| --- | --- | --- |
| alice@acme.test | Acme Robotics | owner |
| bob@acme.test | Acme Robotics | member |
| carol@acme.test | Acme Robotics | viewer |
| dave@globex.test | Globex Data | owner |
| erin@globex.test | Globex Data | member |

## Scripts

| command | what it does |
| --- | --- |
| `npm run dev` | watch mode (`node --watch`) |
| `npm start` | run the API |
| `npm run seed` | load the demo dataset into `data/app.db` |
| `npm test` | integration suites (`node --test`) |
| `npm run typecheck` | `tsc --noEmit` |

## Endpoint map

Auth: `POST /auth/login`, `POST /auth/register`, `POST /auth/logout`, `GET /auth/me`

Org: `GET /tenants`, `GET|PATCH /tenants/:id`, `GET /tenants/:id/stats`,
`GET /tenants/:id/members`, `GET /users`, `GET|PATCH|DELETE /users/:id`,
`GET /users/:id/profile`, `GET /users/:id/avatar`, `GET|POST /members`,
`PATCH|DELETE /members/:id`

Work: `GET|POST /projects`, `GET|PATCH|DELETE /projects/:id`,
`POST /projects/batch-archive`, `GET /projects/:id/summary`,
`GET /projects/:id/tasks`, `GET|POST /tasks`, `GET|PATCH|DELETE /tasks/:id`,
`POST /tasks/batch-update`, `POST /tasks/batch-delete`,
`GET|POST /tasks/:id/comments`, `GET /comments`, `GET|PATCH|DELETE /comments/:id`,
`POST /attachments`, `GET|DELETE /attachments/:id`, `GET /attachments/:id/download`

Insights: `GET|POST /exports`, `GET /exports/:id`, `GET /exports/:id/download`,
`GET /search`, `GET /search/tasks`, `GET /search/projects`, `GET /search/users`,
`GET /reports/overview`, `GET /reports/tasks-by-status`, `GET /reports/activity`,
`GET /reports/utilization`, `GET /reports/export`,
`GET|POST /webhooks`, `DELETE /webhooks/:id`

Admin console (separate SPA, same session): `GET /admin/users`,
`POST /admin/users/:id/suspend`, `DELETE /admin/users/:id`,
`GET /admin/audit-logs`, `GET|PATCH /admin/settings`, `GET /admin/tenants`

Service: `GET /health`, `GET /meta/version`, `GET /meta/regions`, `GET /meta/status`

## Conventions

- Soft delete: `deleted_at` on `projects` and `tasks`; reads filter it out.
- All list endpoints accept `limit` (max 200) and `cursor` (row offset).
- Mutations write an `audit_logs` row through `audit()` in `src/db.ts`.
- The dashboard list endpoints cache their first page in-process for 30s
  (`src/cache.ts`); mutations call `cacheClear()`.
