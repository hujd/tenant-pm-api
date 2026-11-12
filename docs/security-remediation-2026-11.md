# 多租户隔离与权限整改说明

- 版本：tenant-pm-api 1.4.0 安全整改
- 日期：2026-11-12
- 范围：全部 71 个 HTTP 路由（6 个公开路由 + 65 个受保护路由）
- 结论：渗透报告中的三类问题（跨租户列表泄露、URL id 越权、普通成员调用管理员接口）均已修复；同类问题在全部接口上做了系统性排查与修复，不止报告点名的三条。`npm test` 全绿（109 个测试，含 46 个新增安全集成测试），`npm run typecheck` 零错误。

## 1. 总体设计：统一的服务端授权层

整改前，认证只做了“这个 token 是否有效”，授权判断散落在各 handler 里，且大量 handler **完全没有租户判断**。整改后所有授权决策集中到一个新模块 **`src/authz.ts`**，handler 不再各写各的判断：

| 组件 | 职责 |
| --- | --- |
| `requireSession` preHandler 钩子 | 必须登录，否则 401 |
| `requireWriter` preHandler 钩子 | 登录且角色 ≥ member（viewer 写操作 403） |
| `requireAdmin` preHandler 钩子 | 登录且角色为 owner/admin，否则 403 |
| `requireOwnedResource()` | 按 id 加载资源并校验 `tenant_id` 属于当前会话；**资源不存在与属于他人租户统一返回 404**，不泄露他租户资源是否存在 |
| `requireOwnedResources()` | 批量接口版本：逐个 id 校验归属，任一越权则整批拒绝（全有或全无，不产生部分写入） |
| `requireTenantUser()` | users 表无 `tenant_id` 列，通过“在本租户有 active membership”判定可见性 |
| `requireActorOrAdmin()` | 评论等带作者的资源，仅作者本人或租户管理员可改/删 |
| `roleAllows()` | 角色层级（viewer < member < admin < owner）的唯一编码位置 |

状态码约定（与客户要求一致）：

- **401**：无有效会话（未登录、token 过期、membership 已停用）
- **403**：已登录但角色不足（低权限访问）
- **404**：资源不存在 **或** 属于其他租户（防止 id 枚举探测）

路由注册审计脚本 `scripts/audit-routes.ts` 会在 `npm test` 前自动运行，从 Fastify 路由树断言：除 6 个公开端点外，每个路由都挂了中央授权钩子。今后新增路由若忘记授权，CI 直接失败。

## 2. 漏洞清单、成因与修复

### V1 跨租户数据列表泄露（对应报告“能翻到别家租户的项目列表”）

**成因**：多个列表/搜索/报表接口的 SQL 没有 `tenant_id` 过滤，且共享缓存的 key 不含租户维度，A 租户会读到 B 租户缓存的首页数据。

**受影响接口与修复**：

| 接口 | 整改前行为 | 整改后 |
| --- | --- | --- |
| `GET /projects` | 全表 projects，缓存 key 全局共享 | SQL 加 `tenant_id = ?`；缓存 key 加租户前缀 `projects:list:{tenantId}:...` |
| `GET /tasks` | 全表 tasks；`projectId`/`assigneeId` 过滤参数无归属校验 | 强制租户过滤；外租户 projectId/userId 参数直接 404 |
| `GET /comments`、`GET /tasks/:id/comments` | 无租户条件 | 加租户条件，且先校验 task 归属 |
| `GET /exports` | 全表 export_jobs | 仅本租户任务 |
| `GET /search`、`/search/tasks`、`/search/projects`、`/search/users` | 四张表全局模糊搜索 | 全部加租户条件；users 子查询只返回同租户成员 |
| `GET /reports/overview` | 全局计数 + 全局共享缓存 | 按租户计数；缓存 key 加租户前缀 |
| `GET /reports/tasks-by-status` | 全局分组 | 加租户条件 |
| `GET /reports/activity` | 全表 audit_logs | `where tenant_id = ?` |
| `GET /reports/utilization` | 全量用户 + 全量任务 | 仅本租户 active 成员 + 本租户任务 |
| `GET /reports/export`（JSON/CSV 导出） | 全表导出 | 加租户条件；表名仍走固定白名单 |
| `GET /webhooks` | 全表 webhooks | 仅本租户 |
| `GET /users`、`/tenants`、`/members` | users 全局目录；members 可用 `?tenantId=` 查任意租户 | users 仅同租户成员；members/tenantId 只允许本租户 |
| `GET /admin/users`、`/admin/tenants`、`/admin/audit-logs` | 平台级全量数据 | 租户管理员只能看本租户数据 |

### V2 URL id 越权（IDOR）（对应报告“换 id 删别人任务”）

**成因**：`:id` 类接口只按主键查行，不校验该行的 `tenant_id` 是否属于会话租户。批量接口只校验数组第一个 id，后续 id 裸写。

**受影响接口与修复**（全部改为 `requireOwnedResource(s)` 校验，跨租户返回 404）：

- 项目：`GET/PATCH/DELETE /projects/:id`、`GET /projects/:id/summary`、`GET /projects/:id/tasks`、`POST /projects/batch-archive`
- 任务：`GET/PATCH/DELETE /tasks/:id`、`POST /tasks/batch-update`、`POST /tasks/batch-delete`、`GET/POST /tasks/:id/comments`
- 评论：`GET/PATCH/DELETE /comments/:id`（PATCH/DELETE 额外要求作者本人或管理员）
- 附件：`GET /attachments/:id`、`GET /attachments/:id/download`（防止存储 key 泄露）、`DELETE /attachments/:id`、`POST /attachments`（校验 taskId 归属）
- 导出：`GET /exports/:id`、`GET /exports/:id/download`
- Webhook：`DELETE /webhooks/:id`
- 组织：`GET/PATCH /tenants/:id`、`GET /tenants/:id/stats`、`/tenants/:id/members`、`GET/PATCH/DELETE /users/:id`、`/users/:id/profile`、`/users/:id/avatar`、`PATCH/DELETE /members/:id`
- 管理端：`POST /admin/users/:id/suspend`、`DELETE /admin/users/:id`、`GET/PATCH /admin/settings`、`GET /admin/audit-logs`

**批量接口的原子性**：`batch-archive`、`batch-update`、`batch-delete` 现在先校验**全部** id 均属于本租户，任何一个越权即整体 404 且不写入；UPDATE 语句也附带 `tenant_id` 条件作为纵深防御。

### V3 垂直越权 / 权限提升（对应报告“普通成员能调管理员接口”）

**成因（最严重的一条）**：`src/routes/admin.ts` 的 `adminGate` 读取客户端请求头 `x-role`，只要自己带上 `x-role: admin` 就是管理员——任何登录用户都能提权。

**修复**：

- 彻底删除对 `x-role` 头的信任，所有 `/admin/*` 改用 `requireAdmin` 钩子，角色只取自服务端会话（membership 表）。
- 管理员接口全部限定在调用者自己的租户内：`tenantId` 查询参数/请求体若指向其他租户，403/404；停用/删除用户只影响本租户的 membership，不再误伤用户在其他租户的账号。
- 以下接口统一改为 `requireAdmin`（owner/admin）：`PATCH /tenants/:id`、`POST /members`、`PATCH/DELETE /members/:id`、`DELETE /users/:id`、全部 `/admin/*`。
- 写操作统一改为 `requireWriter`（member 及以上）：项目/任务/评论/附件/webhook 的增删改、评论发表等。viewer 现在写操作得到 403（此前 viewer 可任意写）。
- `PATCH /users/:id` 收紧为“本人或本租户管理员”。

### V4 导出功能的租户注入

**成因**：`POST /exports` 把请求体里的 `filters.tenantId` 原样存库，下载时据此查询——攻击者填别人的 tenantId 即可导出他租户全量数据；下载接口本身也不校验 export job 归属。

**修复**：创建导出任务时忽略客户端传入的 `tenantId`，强制用会话租户覆盖；`projectId` 过滤先做归属校验；下载时再次以会话租户作为强制 where 条件（纵深防御），并校验 job 归属。

### V5 会话与停用状态脱节

**成因**：`resolveSession` 不检查 membership 状态，被停用/移除的成员旧 token 仍然有效。

**修复**：会话解析要求 membership 为 `active`；停用/移除成员时同步删除该租户下的会话。相关行为有专门测试覆盖。

## 3. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `src/authz.ts`（新增） | 中央授权层：RBAC 策略、三个 preHandler 钩子、资源归属校验、租户用户校验、HTTP 错误类型 |
| `src/app.ts` | 错误处理器识别 `HttpError`；更新注释指向中央授权层 |
| `src/auth.ts` | `resolveSession` 增加 membership `active` 校验，停用成员的会话立即失效 |
| `src/db.ts` | **仅新增 8 个索引**（见下），无任何表/列/schema 结构变更 |
| `src/routes/helpers.ts` | 删除散落的 `requireCtx/requireAdminCtx`，只保留分页工具 |
| `src/routes/work.ts` | 项目/任务/评论/附件全部接入授权钩子与租户校验；缓存 key 租户化；批量接口原子校验 |
| `src/routes/org.ts` | 租户/用户/成员接口的租户隔离与角色收紧；users 目录按 membership 过滤 |
| `src/routes/insights.ts` | 导出/搜索/报表/webhook 全部租户化；导出 tenantId 注入修复；缓存租户化 |
| `src/routes/admin.ts` | 删除 `x-role` 头信任；全部接口改为服务端角色判定 + 本租户范围 |
| `src/routes/auth.ts` | logout/me 接入 `requireSession` 钩子 |
| `src/seed.ts` | 扩充两租户 fixture：评论/附件/webhook/每租户导出任务的稳定 id，供安全测试使用 |
| `scripts/audit-routes.ts`（新增） | CI 路由授权覆盖审计（`npm test` 自动执行） |
| `tests/security-*.test.ts`（新增 4 个文件，46 个用例） | 见第 4 节 |
| `tests/admin.test.ts` | 两个断言“跨租户全局视图”的旧用例更新为断言“仅本租户”（旧断言本身就是漏洞行为） |
| `tests/helpers.ts` | 新增 `auth()`（只带 Bearer，不带可伪造的 x-role），保留 `as()` 兼容 |
| `package.json` | `test` 脚本前置 `audit:routes` |

新增索引（只加索引，可在线上库直接执行，不改动任何表结构）：

```sql
create index if not exists idx_memberships_tenant_user on memberships (tenant_id, user_id, status);
create index if not exists idx_comments_tenant         on comments (tenant_id);
create index if not exists idx_attachments_tenant      on attachments (tenant_id);
create index if not exists idx_export_jobs_tenant      on export_jobs (tenant_id);
create index if not exists idx_webhooks_tenant         on webhooks (tenant_id);
create index if not exists idx_tasks_tenant_project    on tasks (tenant_id, project_id);
create index if not exists idx_projects_tenant_active  on projects (tenant_id, deleted_at);
create index if not exists idx_sessions_user_tenant    on sessions (user_id, tenant_id);
```

## 4. 测试覆盖

测试通过 `app.inject` 走完整 HTTP 栈，使用 `seed.ts` 中两个真实租户（Acme / Globex）的 fixture 数据。每个被修复的接口都有一对用例：**本租户正常访问成功** + **跨租户/低权限访问被拒绝（403 或 404）**，并额外断言被攻击的数据行未被修改/删除、未在响应中泄露。

| 测试文件 | 覆盖内容 |
| --- | --- |
| `tests/security-auth.test.ts` | 全部受保护路由无 token 一律 401（GET 与写操作分别枚举）；伪造/未知 token、过期会话、停用/移除成员会话失效；公开端点仍可匿名访问 |
| `tests/security-work.test.ts` | 项目/任务/评论/附件的每个端点的正/负用例；三个批量接口的混合租户 id 原子拒绝；附件下载跨租户不泄露 storage_key；viewer 写操作 403；评论仅作者/管理员可改 |
| `tests/security-org.test.ts` | 租户/用户/成员接口的跨租户 404；用户目录与 profile 不泄露其他租户；成员管理的角色要求与 body 内 tenantId 伪造；跨租户停用用户不影响其外租户 membership |
| `tests/security-insights.test.ts` | 导出任务/下载的租户隔离；`filters.tenantId` 伪造被会话租户覆盖；搜索/报表/CSV 导出/webhook 租户化；报表缓存不串租户；**x-role 头伪造提权回归**；管理员跨租户操作被拒；停用后旧会话失效 |

原有 63 个测试中 61 个原样通过；仅 `tests/admin.test.ts` 的 2 个用例因断言的是漏洞行为（全局用户数 ≥5、全局租户数 ≥2）而更新为正确的租户内断言。整改后总计 **109 个测试全部通过**。

## 5. 硬约束遵守情况

- **数据库 schema 不动**：未修改任何表/列/约束，仅 `create index if not exists`（8 个新索引），对线上数据安全。
- **URL 路径与响应字段不变**：所有路由路径、HTTP 方法、请求/响应字段名保持原样；成功响应的结构与字段未改，只收紧了错误场景（越权从 200 变为 403/404，这是修复目的本身）。
- **正常功能不退化**：原有功能用例保持通过；既有角色语义（owner/admin/member/viewer）不变，viewer 可读不可写、member 可写、admin/owner 可管理。
- **权限判断统一在服务端一处**：全部 65 个受保护路由经 `src/authz.ts` 的钩子/助手授权，并有 CI 审计脚本防止后续回退。

## 6. 复实验证

```bash
npm ci
npm run typecheck     # 零错误
npm test              # 先跑路由授权审计，再跑 109 个集成测试，全部通过
```
