"use client";

import { useEffect, useState } from "react";

/** Whether this element is a form field whose edits count as unsaved work: a field inside a form of the page's main
    content or inside a dialog. Search boxes and fields marked data-unsaved-ignore do not count. */
function countsAsWork(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return false;
  if (target instanceof HTMLInputElement && target.type === "search") return false;
  if (target.closest('[role="search"], [data-unsaved-ignore]')) return false;
  return Boolean(target.closest("#main form, .tc-dialog"));
}

/** True once the person has typed or chosen something in a form on this page, until they open another page.
    Used so an automatic redirect never silently discards their input. Only this yes/no flag is kept, in memory:
    no field value is read, stored or sent anywhere. Saving does not clear it, so the answer errs on asking. */
export function useUnsavedInput(pathname: string): boolean {
  const [state, setState] = useState({ pathname, dirty: false });
  if (state.pathname !== pathname) setState({ pathname, dirty: false }); // A new page starts clean.

  useEffect(() => {
    const mark = (event: Event) => {
      if (countsAsWork(event.target)) setState((s) => (s.dirty ? s : { ...s, dirty: true }));
    };
    document.addEventListener("input", mark, true);
    document.addEventListener("change", mark, true);
    return () => {
      document.removeEventListener("input", mark, true);
      document.removeEventListener("change", mark, true);
    };
  }, []);

  return state.pathname === pathname && state.dirty;
}
