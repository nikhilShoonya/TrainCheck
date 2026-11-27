/* The one Back control at the top of workspace pages: destination labels, return state, the previous-page trail and
   the Dashboard fallback. Run: npm run test:unit */
import assert from "node:assert/strict";
import { test } from "node:test";
import { backTarget, internalUrl, pageName, parentTarget, readTrail, trackPage } from "@/components/shell/backNav";

const ID = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";
const params = (query = "") => new URLSearchParams(query);
const admin = (pathname, query = "", previous = null) => backTarget({ pathname, params: params(query), previous, role: "LD_ADMIN", roles: ["LD_ADMIN", "EMPLOYEE"] });

test("detail views return to their parent with its return state", () => {
  assert.deepEqual(admin("/lnd/assignments", `employee=${ID}&search=asha&department=dep-1&status=active`), { label: "Back to Employees", href: "/lnd/assignments?department=dep-1&status=active&search=asha" });
  assert.deepEqual(admin(`/lnd/completion/${ID}`, "q=customer"), { label: "Back to Trainings", href: "/lnd/completion?q=customer" });
  assert.deepEqual(admin(`/lnd/questions/${ID}/post-test`, "q=awareness"), { label: "Back to Trainings", href: "/lnd/questions?q=awareness" });
  assert.deepEqual(admin("/lnd/questions/unassigned"), { label: "Back to Trainings", href: "/lnd/questions" });
  assert.deepEqual(admin(`/lnd/reports/employees/${ID}`, `back=${encodeURIComponent("report=pass-fail&department_id=dep-1")}`), { label: "Back to Reports", href: "/lnd/reports?report=pass-fail&department_id=dep-1" });
  assert.deepEqual(backTarget({ pathname: `/employee/behaviour/${ID}`, params: params(), previous: null, role: "EMPLOYEE", roles: ["EMPLOYEE"] }), { label: "Back to Self-Assessment", href: "/employee/behaviour" });
});

test("a parent wins over the previous page, so a direct link or refresh still leads to the parent", () => {
  assert.equal(admin(`/lnd/completion/${ID}`, "", "/lnd/reports").label, "Back to Trainings");
  assert.equal(admin(`/lnd/completion/${ID}`).href, "/lnd/completion");
  assert.equal(admin("/lnd/assignments", `employee=${ID}`).href, "/lnd/assignments");
});

test("the list itself is not a detail view", () => {
  assert.equal(parentTarget("/lnd/assignments", params("search=asha")), null);
  assert.equal(parentTarget("/lnd/completion", params("q=x")), null);
  assert.equal(parentTarget("/lnd/questions", params()), null);
});

test("other pages return to the previous TrainCheck page, named after it, with its address", () => {
  assert.deepEqual(admin("/lnd/trainings", "", "/lnd/reports?report=pass-fail"), { label: "Back to Reports & Analytics", href: "/lnd/reports?report=pass-fail" });
  assert.deepEqual(admin("/lnd/reports", "", `/lnd/completion/${ID}?q=x`), { label: "Back to Training Completion", href: `/lnd/completion/${ID}?q=x` });
  assert.deepEqual(admin("/notifications", "", "/lnd/assignments?employee=x"), { label: "Back to Employee Assignments", href: "/lnd/assignments?employee=x" });
  assert.deepEqual(admin("/profile", "", "/lnd"), { label: "Back to Dashboard", href: "/lnd" });
  assert.deepEqual(admin("/lnd/reports", "", "/profile"), { label: "Back to My Profile", href: "/profile" });
});

test("with no usable previous page, Back leads to the Dashboard", () => {
  for (const previous of [null, "", "https://example.com/lnd", "//example.com/lnd", "/\\example.com", "/login", "/assessment/start/x", "/results/x", "/lnd/unknown-page", "/lnd/trainings"]) {
    assert.deepEqual(admin("/lnd/trainings", "", previous), { label: "Back to Dashboard", href: "/lnd" }, String(previous));
  }
  // A page this person cannot open is never offered.
  assert.deepEqual(backTarget({ pathname: "/employee/trainings", params: params(), previous: "/lnd/reports", role: "EMPLOYEE", roles: ["EMPLOYEE"] }), { label: "Back to Dashboard", href: "/employee" });
});

test("the Dashboard has no Back control", () => {
  assert.equal(admin("/lnd", "", "/lnd/reports"), null);
  assert.equal(backTarget({ pathname: "/employee", params: params(), previous: "/employee/trainings", role: "EMPLOYEE", roles: ["EMPLOYEE"] }), null);
  // An L&D Admin's own learner workspace is not their Dashboard.
  assert.deepEqual(admin("/employee", "", "/lnd/reports"), { label: "Back to Reports & Analytics", href: "/lnd/reports" });
});

test("page names follow the sidebar and the detail pages", () => {
  assert.equal(pageName("/lnd/assignments?search=x", "LD_ADMIN"), "Employee Assignments");
  assert.equal(pageName("/employee", "LD_ADMIN"), "My Own Training");
  assert.equal(pageName("/employee", "EMPLOYEE"), "Dashboard");
  assert.equal(pageName("/employee/trainings", "LD_ADMIN"), "My Trainings");
  assert.equal(pageName(`/lnd/questions/${ID}/pre-test`, "LD_ADMIN"), "Question Bank");
  assert.equal(pageName(`/lnd/reports/employees/${ID}`, "LD_ADMIN"), "Employee Scorecard");
  assert.equal(pageName("https://example.com/lnd", "LD_ADMIN"), null);
  assert.equal(internalUrl("/lnd/reports?x=1").pathname, "/lnd/reports");
  assert.equal(internalUrl("javascript:alert(1)"), null);
});

test("the trail remembers the previous page, not the same page's own filters", () => {
  let trail = trackPage(null, "u1", "/lnd/reports");
  assert.deepEqual(trail, { user: "u1", current: "/lnd/reports", previous: null });
  trail = trackPage(trail, "u1", "/lnd/reports?report=pass-fail");
  assert.deepEqual(trail, { user: "u1", current: "/lnd/reports?report=pass-fail", previous: null });
  trail = trackPage(trail, "u1", "/lnd/trainings");
  assert.deepEqual(trail, { user: "u1", current: "/lnd/trainings", previous: "/lnd/reports?report=pass-fail" });
  // A refresh, or rendering again, changes nothing.
  assert.deepEqual(trackPage(trail, "u1", "/lnd/trainings"), trail);
  // Another person in the same tab starts afresh.
  assert.deepEqual(trackPage(trail, "u2", "/lnd/imports"), { user: "u2", current: "/lnd/imports", previous: null });
  // An address outside the workspace is not recorded.
  assert.deepEqual(trackPage(trail, "u1", "//example.com"), trail);
});

test("a damaged stored trail is ignored", () => {
  assert.equal(readTrail("not json"), null);
  assert.equal(readTrail(JSON.stringify({ current: 5 })), null);
  assert.deepEqual(readTrail(JSON.stringify({ user: "u1", current: "/lnd", previous: 7 })), { user: "u1", current: "/lnd", previous: null });
});
