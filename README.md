# FoundersLab — Phases 1–3: Foundation, Company Builder, AI + Human Workforce, Operations & Reporting

Multi-tenant "Startup OS". Phase 1 delivers accounts, company workspaces, the organization hierarchy builder,
roles, responsibilities, rules, KPIs-per-role, a server-enforced permission system, employee invites and
role assignment, a founder dashboard shell and an audit log.

## Run it
```bash
npm install
cp .env.example .env        # optional for local dev
npm run dev                 # http://localhost:3000  (embedded PGlite Postgres in ./.data/pglite)
npm test                    # 91 tests: auth, isolation, authz, hierarchy, workforce, AI, tasks, KPIs, reports, exports, upgrade path
npm run build && npm start
```
Production: set `DATABASE_URL=postgres://…` (PostgreSQL 14+). Migrations in `./drizzle` run automatically at startup.
Change the schema in `src/db/schema.ts`, then `npm run db:generate`.

## Stack and one deliberate deviation
Next.js 15 (App Router) · React 19 · TypeScript · Tailwind · PostgreSQL · **Drizzle ORM** (not Prisma).
Prisma downloads native engines at install time, which the build sandbox blocked, so the schema is Drizzle/Postgres.
Same relational design; switching later is mechanical.

## Architecture
- `src/db/schema.ts` – tables, enums, indexes. **Tenant isolation at DB level**: every tenant table has `company_id`
  and all links between tenant tables are composite foreign keys `(company_id, id)`; a row can never reference
  another company's row even if application code is wrong (tested).
- `src/server/router.ts` – REST dispatcher (`/api/*`), testable without a server. CSRF origin check, JSON-only, error mapping.
- `src/server/authz.ts` – per-request `Ctx` (user + verified membership + effective permissions). Non-members get 404.
- `src/server/services/*` – business logic; every function checks `ctx.require('<resource>.<action>', target)`.
- `src/lib/templates.ts` – 12 role templates, 6 organization templates (all editable).
- `src/lib/nav.ts` – navigation architecture; later-phase items exist with `enabled:false` and are not rendered.

## Access model (hierarchy ≠ access)
- Access levels: owner (everything, exactly one per company), admin (explicit editable grants; default preset excludes
  `permissions.configure`, `finance.*`, `members.delete`), member (only what assigned roles grant + `company.view`).
- Permissions = 13 resources × 8 actions. Role grants have a scope: whole company / own department / own role only.
- Reporting lines never grant access.
- No privilege escalation: you can only grant permissions you hold. Template defaults are clipped; explicit over-grants are rejected.
- Delete = archive. Roles, responsibilities, departments and assignments keep history; changes are in `audit_logs` (secrets redacted).

## Needs configuration / not yet real
- Email: only a console transport exists (`src/server/mailer.ts`). Invite/reset emails are NOT delivered; with
  `EXPOSE_DEV_LINKS=1` (never in production) the link is shown in the UI. Implement `Transport` for SMTP/Resend/SES.
- Logo: URL field only; upload arrives with S3-compatible storage.
- Rate limiting is in-memory (per instance); use Redis for multiple instances.
- Postgres Row-Level Security is not enabled; composite FKs + service checks enforce isolation. RLS is a good hardening step.
- Hosting needs Node 20+ and PostgreSQL; PHP-only shared hosting cannot run this.
- Not in Phase 1: ownership transfer, SSO/2FA, email verification, e2e browser tests.

## Hooks for Phase 2+
`roles.role_type` has `ai`/`hybrid`; `role_assignments` is where AI-agent assignment joins; the permission catalog already lists
tasks/projects/reports/kpis/finance/knowledge; `audit_logs` and `role_kpis` are ready for performance tracking.

---
# Phase 2 — AI and Human Workforce

**Upgrading from Phase 1:** just deploy; migration `0001` runs at startup. It keeps all Phase 1 data, back-fills an employee profile
for every member, and makes exactly one assignee the owner of each role (tested against a database holding Phase 1 data).

## What was added
- **Human employees** (`services/employees.ts`): profile (title, phone, bio, start date), department, manager (loop-checked), status
  (active / on leave / inactive), invitation presets (department, manager, title, several roles), onboarding checklist,
  deactivate / reactivate, per-person permissions. Several employees can share a department.
- **AI employees** (`services/agents.ts`): name, role(s), department, accountable human manager, instructions, tools, knowledge scope,
  autonomy level, monthly token/USD budget, activate/deactivate, versioned configuration, activity history.
- **Role assignment** (`services/assignments.ts`): people and AI in the same role, many members per role, one **owner** per role
  (promoted automatically if the owner leaves). Mode is derived: nobody → Vacant · people → Human · AI → AI · both → Hybrid.
  In hybrid roles you pick which responsibilities the AI performs; the humans keep the rest.
- **Workforce dashboard**: role assignment table (mode, owner, team, department, reports-to, responsibilities) and a directory of people + AI.
- **AI service layer** (`server/ai/*`): provider-independent interface, Anthropic and OpenAI-compatible adapters, tool calling, structured
  (JSON-validated) output with one retry, per-call usage records, per-run history, token limits.

## Autonomy (enforced in code by `decideTool`, tested)
| Level | Behaviour |
|---|---|
| 1 Suggest only | May read (within knowledge scope). Any change it attempts is recorded as a suggestion; nothing is applied. |
| 2 Draft for review | Changes become drafts a human reviews; nothing is applied, even when approved. |
| 3 Execute approved | Actions are queued; a human with `agents.approve` must approve each one, then it runs. |
| 4 Routine auto-execution | Routine tools that an approver pre-authorised run on their own; everything else queues as in Level 3. |

**External actions do not exist yet:** email, publishing, payments and web search are listed but "not connected", cannot be enabled,
and are refused at run time at every level (even if a database row were tampered with). Today's only write tool is
`org_add_responsibility` (a role the AI holds). AI employees never get user permissions: they act only through enabled tools.
Raising autonomy to 3/4 or enabling unattended execution requires `agents.approve`.

## What is real and what is not
- **No AI is "faked".** With no provider key a run is recorded as **blocked** with the exact setup instruction. Set `ANTHROPIC_API_KEY`
  and/or `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`) on the server; see `.env.example`.
- The two adapters follow the vendors' public HTTP formats and are tested against recorded request/response fixtures **only**. They have not
  been run against the live services (no keys were available). Do a first run with a cheap model and a small token limit.
- Orchestration tests use a scripted model (a test double registered only inside tests).
- USD budgets are enforced only when `AI_MODEL_PRICING_JSON` has the model's price; otherwise cost shows "n/a" and the **token limit** is the hard control.
- Rate limit on runs is in-memory (per instance).

## New permissions
Resource `agents` (view/create/edit/delete/assign/approve/configure…). Admin preset gets view/create/edit/assign — not configure, approve or delete.
`edit` also lets a person run an AI employee; with scope "own role" a human sharing a role can run their AI colleague.

## Ready for Phase 3
`ai_runs`, `ai_usage_records`, `ai_work_items`, `role_kpis`, `audit_logs` and `role_assignments` carry the history Phase 3 needs for tasks,
KPIs and hierarchy-based reports; AI work items are the natural source for task creation.

---
# Phase 3 — Tasks, Projects, KPIs, Performance, Reports

**Upgrading:** deploy; migration `0002` runs at startup (tested against a database holding Phase 1 data).
It also moves roles created from templates to least-privilege scopes (see "Report access") and back-fills numeric KPI targets.
Admins created before Phase 3 are **not** given the new task/project/report permissions automatically — grant them in Employees → Permissions.

## What was added
- **Tasks** (`services/tasks.ts`): owner (person or AI), creator, department/role/responsibility/project links, priority, 8 statuses with enforced
  transitions, start/due dates, estimates, subtasks (3 levels), dependencies (cycle-checked), deliverables, comments, attachments, activity history,
  recurring tasks, approvals, notifications. Views: list, board (drag to change status), calendar.
  Rules: *blocked* needs a reason · starting/finishing waits for dependencies · completing needs all deliverables ticked and subtasks finished · tasks that
  require approval go In Review → Awaiting Approval → Completed by someone with `tasks.approve` who is not the owner (the company owner excepted).
- **Projects**: owner, team (people and AI), department, dates, status, goals, deliverables, related tasks; progress and health (on track / at risk / late) computed from tasks and dates.
- **KPIs** (extends Phase 1 role KPIs): target, direction (higher/lower is better), measurement period, reporting frequency, data source, responsible role, sensitivity.
  Sources: manual entry, or calculated from real tasks (completion rate, on-time rate, overdue, completed, blocked). Attainment ≥100% met · ≥80% on track · ≥50% at risk · else off track.
  Template KPIs arrive wired (COO KPIs are calculated; CFO KPIs are financial).
- **Responsibility tracking**: per responsibility — owner, related tasks, completion, next deadline, expected outcome, on-time rate, status.
- **Performance dashboard**: company, department, role, employee, AI employee, project — all computed per request from stored records.
- **Reports** (9 types × daily/weekly/monthly/quarterly/custom): company, department, role, employee, AI employee, task completion, KPI, project, risk. Definitions are printed on every report.
- **Founder command center**: health score (transparent weights; says "not enough data" rather than inventing), active projects, task completion, overdue, department/role performance, AI and human activity, pending approvals, upcoming deadlines, risks.
- **Exports**: CSV (UTF-8 BOM, formula-injection safe) and PDF. View **and** export permission are checked before any file is generated.
- **Notifications**: assignment, comments, status changes, approval requests, due soon / overdue (deduplicated), bell in the header.
- **AI tools**: `tasks_read` and `tasks_create` (subject to the Phase 2 autonomy rules; AI-created tasks are owned by and attributed to the AI).

## Report access — hierarchy is never access
Access comes only from: company owner · a `reports.view` grant · explicit "custom report access" rows · yourself.
The **scope** of a `reports.view` grant decides the extent: *company* = everything · *department* = your own department(s) · *own* = your own role and the roles below it in the hierarchy (team).
Being a manager on the org chart without that grant shows nothing. Employees get only their own personal report; colleagues' performance is not exposed through a shared role.
**Financial and HR KPIs** need `finance.view` / `members.view` (scoped like any permission) regardless of hierarchy or report scope; hidden items are listed as "restricted", never silently shown.
Exporting needs `reports.export` in a scope covering the report (your own personal report is always exportable).
Template roles now default to: CEO company-wide; CMO/CFO/CTO/CRO/CHRO department; COO department for reports (company for tasks); managers team ("own") for reports.

## Limits and honest notes
- Not browser-tested end to end; the API is covered by tests and the production build was smoke-tested over HTTP (including PDF/CSV download).
- **Attachments** are stored in the database (max 2 MB, allow-listed types, served as downloads with nosniff). Fine for documents; switch to S3-compatible storage for large files.
- **Recurring tasks** are generated lazily (on task/dashboard load or `POST /recurring-tasks/run`) and catch up after downtime. A scheduled worker arrives in Phase 5.
- Notifications are in-app only; no email/push is sent.
- PDF uses built-in Latin fonts; set `PDF_FONT_PATH` for other scripts. CSV is always complete.
- Reports and lists load a company's records into memory (fine for startups; paginate/aggregate in SQL before very large datasets). Task lists cap at 600 rows.
- Report "Risk" rules are simple heuristics (documented in the report); thresholds are in `computeRisks`.
- No scheduled report generation or sharing links yet (Phase 5).

## Ready for Phase 4
Task history, comments, attachments, `report_grants`, `audit_logs`, role/assignment history and AI work items are the records handover needs:
open tasks per person, owned projects, pending approvals and KPI responsibilities can be listed per role/person and reassigned.
