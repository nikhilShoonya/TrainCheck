/* Assign employees: search, and "select all shown". Selection is kept by ID, so changing the search never drops
   someone already ticked. Pure functions, unit-tested in tests/unit/assignView.test.mjs. The backend re-checks
   every rule (active employee, audience, existing assignment). */

export interface AssignablePerson {
  id: string;
  full_name: string;
  employee_code: string;
  department: string | null;
  function: string | null;
}

/** People matching the search by name, ID, department or function, ignoring case and surrounding spaces. */
export function filterPeople<T extends AssignablePerson>(people: T[], search: string): T[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return people;
  return people.filter((p) => `${p.full_name} ${p.employee_code} ${p.department ?? ""} ${p.function ?? ""}`.toLowerCase().includes(needle));
}

/** Whether every person shown is already selected (false when nobody is shown). */
export function allShownSelected(selected: ReadonlySet<string>, shown: AssignablePerson[]): boolean {
  return shown.length > 0 && shown.every((p) => selected.has(p.id));
}

/** Selects everyone shown, or, when they are all selected already, unselects them. Others stay as they were. */
export function toggleShown(selected: ReadonlySet<string>, shown: AssignablePerson[]): Set<string> {
  const next = new Set(selected);
  const clear = allShownSelected(selected, shown);
  for (const p of shown) {
    if (clear) next.delete(p.id);
    else next.add(p.id);
  }
  return next;
}

export function toggleOne(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
