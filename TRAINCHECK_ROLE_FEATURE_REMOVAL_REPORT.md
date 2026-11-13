# TrainCheck – Role Feature Removal Report

**Date:** 13 Nov 2026 · **Scope:** remove Assessment History and Behaviour History from Employees, and Team Training Status and Team Reports from Managers. Nothing is committed.

## 1. Features removed from the Employee role

| Feature | Sidebar | Page / route | Direct URL | Backend |
|---|---|---|---|---|
| Assessment History | Removed | `/employee/history` and the `MyHistory` component deleted | 404 (verified on the running dev server) | `GET /me/history` retired (its only consumer). The personal history export (`POST /reports/exports` with `own_record: true`) is refused with 403 for every role. Employees no longer get report access (`/reports/employee-history` and exports return 403; the report catalogue is empty). |
| Behaviour History | Removed (it was already hidden while Behaviour is off) | `/employee/behaviour-history` and the `MyBehaviourHistory` component deleted | 404 (verified) | None needed. `GET /me/behaviour-reviews` is shared with the hidden Self-Assessment page, so it was kept. |

The `/employee/*` area is also each Manager's, L&D Admin's and HR user's own "My own training" area, so these two pages are gone for their own records too.

## 2. Features removed from the Manager role

| Feature | Sidebar | Page / route | Other UI references removed | Direct URL | Backend |
|---|---|---|---|---|---|
| Team Training Status | Removed | `/manager/team-trainings` and the `TeamTrainings` component deleted | The "Team Training Status" panel on the Manager dashboard. The header-search "training" shortcut now opens Assessment Performance. | 404 (verified) | `GET /manager/team-trainings` was **kept**: the Assessment Performance page uses it for its Training filter. |
| Team Reports | Removed | `/manager/reports` and the `ManagerReports` component deleted | The "Export Team Report" button on Assessment Performance | 404 (verified) | Managers now get 403 on report tables (`GET /reports/{code}`), on exports other than the scorecard, and when creating schedules. The report catalogue lists only `scorecard` for managers. |

## 3. Routes and components modified or removed

**Deleted:** these four route files, `frontend/src/app/(workspace)/`:
- `employee/history/page.tsx`
- `employee/behaviour-history/page.tsx`
- `manager/team-trainings/page.tsx`
- `manager/reports/page.tsx`

**Modified:**
- `frontend/src/components/shell/nav.ts`: removed the four sidebar items and their Hindi labels. Removed the deleted Behaviour History path from `BEHAVIOUR_PATHS`.
- `frontend/src/components/shell/AppShell.tsx`: the Manager search shortcut now points to `/manager/assessments`.
- `frontend/src/features/employee/pages.tsx`: removed `MyHistory`, `MyBehaviourHistory` and their now-unused imports.
- `frontend/src/features/manager/pages.tsx`: removed `TeamTrainings`, `ManagerReports`, the dashboard panel, the export button and unused imports. This also removed `Empty`/`Modal` imports left behind by the earlier certificate removal.
- `frontend/src/styles/traincheck.css`: one rule, `.manager-secondary-grid:has(> :only-child){grid-template-columns:1fr}`, so the remaining "Action Items" panel spans the dashboard row instead of leaving an empty column. Existing breakpoints already collapse it to one column.
- `frontend/tests/e2e/journeys.spec.ts`: the four paths are removed from the per-role page sweep.

Sidebars after the change (with Behaviour switched off, as configured):
- **Employee:** Dashboard · My Trainings · Assessments · Refresher Materials
- **Manager:** Dashboard · My Team · Assessment Performance · Team Scorecards
- **L&D Admin and HR:** unchanged.

## 4. Backend permission and API changes

| File | Change |
|---|---|
| `backend/app/modules/employee/router.py` | Removed `GET /me/history`. |
| `backend/app/modules/reports/router.py` → `resolve_scope` | L&D and HR keep organisation scope. Managers keep only the `scorecard` report, scoped to their team, because the Team Scorecards page exports it. Employees have no report access. |
| `backend/app/modules/reports/router.py` → `catalogue` | L&D/HR: all reports. Manager: `scorecard`. Employee: none. |
| `backend/app/modules/reports/router.py` → `create_export` | `own_record: true` → 403. The field is kept, so old clients get a clear 403 rather than a validation error. |
| `backend/app/modules/reports/router.py` → `download_export` | Every download re-checks today's permission. Before, personal history files skipped the check. |
| `backend/app/modules/reports/router.py` → `create_schedule` | L&D and HR only. |

Authentication, the assessment gate and every L&D/HR permission are unchanged.

## 5. Shared components and APIs intentionally preserved

- `GET /manager/team-trainings` (Assessment Performance filter), `GET /manager/dashboard` (it still returns `team_status`, which is now unused by the UI), `GET /me/behaviour-reviews`.
- For managers: `/reports/filter-options`, `/scorecards`, `/scorecards/{id}`, `/reports/analytics`, plus scorecard export and download, all used by Team Scorecards.
- `ReportsHub`, `ReportPanel` and `ExportButtons` are still used by L&D and HR.
- The L2 assessment engine, gate, attempts, submission, scoring and results were not touched.

## 6. Historical data

No tables, migrations or rows were deleted or changed. Assessment attempts, behaviour reviews, report exports and report schedules all remain in the database. Old exports and schedules now follow current permissions (see section 8).

## 7. Tests executed and actual results

| Check | Result |
|---|---|
| Frontend `npm run typecheck` (after `next typegen` regenerated route types for the deleted pages) | Passed |
| Frontend `tsc --noUnusedLocals` on the edited modules | No unused locals |
| ESLint on edited frontend files | Passed |
| Backend `ruff check app tests` | Passed |
| Direct URLs on the running dev server | `/employee/history`, `/employee/behaviour-history`, `/manager/team-trainings`, `/manager/reports` → **404**. `/employee`, `/employee/trainings`, `/employee/assessments`, `/manager`, `/manager/assessments`, `/manager/scorecards`, `/lnd`, `/lnd/reports`, `/hr`, `/hr/reports` → **200** |
| Sidebar check (actual `navFor` per role) | Matches section 3 |
| DB-free API check against the real app (fake signed-in roles; the database stub fails if touched) | 13/13 passed. Manager: 403 on pass-fail/compliance views, pass-fail export, personal export and new schedules; catalogue = `scorecard`. Employee: 403 on employee-history view and exports; empty catalogue; `/me/history` 404. HR and L&D: 7 reports each. Shared routes present. |
| Earlier admin permission invariants (every admin write route still L&D-only, Batches/Audit still withdrawn) | Passed (110 routes) |
| **Backend pytest suite** | **Not run.** It needs the local test database (`TEST_DATABASE_URL`, 127.0.0.1:55432), which is not available here. |
| **Playwright e2e** | **Not run.** It needs a running backend with seeded data and sign-in. |

Backend tests updated to the new rules, but **not executed**:
- `tests/test_gate.py`: `/me/history` dropped from the gate list.
- `tests/test_reports.py`: manager → scorecard-only export test, employee export permissions, scheduled delivery now owned by HR (a manager gets 403), personal-export retirement test.
- `tests/test_rbac.py`: the manager scope-cannot-widen check now uses `/reports/analytics`.

Not re-tested here because those code paths were not changed: the active assessment, the gate and submission. The e2e page sweep covers them once it can run.

## 8. Remaining dependencies and issues

1. **Existing manager report schedules** (if any exist in your database) stay active. Each run now records a FAILED delivery, because managers can no longer run those reports. L&D can stop them, or I can add a one-off cleanup if you want.
2. **Old files:** managers' earlier non-scorecard exports, and employees' earlier personal history exports, are kept but can no longer be downloaded.
3. **Out of scope, reported only:** the Manager dashboard's "Action Items" panel still says "Behaviour Reviews Pending" and links to `/manager/reviews` (Level 3). It was already there and was not part of this request.
4. `All_Doc/` documents still describe these pages; they were not edited.
