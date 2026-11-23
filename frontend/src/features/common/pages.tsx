"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { ROLE_LABEL } from "@/components/shell/nav";
import { Badge, Btn, BtnLink, Empty, ErrorPanel, Loaded, PageTitle, TextField, useToast } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { canChangeOwnPassword } from "@/features/admin/employeeView";
import { useApi, useSession } from "@/lib/hooks";
import { dateTime } from "@/lib/utils";
import { mayHaveOlder, noReadChanges, olderPagePath, reconcileReadState, replaceInOlder, shownNotifications, withMark, withMarkAll, withOlderPage, type Older } from "./notificationPages";

interface NotificationView {
  id: string;
  type: string;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  created_at: string;
}

export function NotificationsPage() {
  const state = useApi<NotificationView[]>("/me/notifications");
  const toast = useToast();
  // Older pages, appended below the cached first page (audit B21).
  const [older, setOlder] = useState<Older<NotificationView> | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderStatus, setOlderStatus] = useState("");
  // Read-state changes, numbered, so an older page requested before one of them cannot undo it when it arrives.
  const readChanges = useRef(noReadChanges());
  // The first page as it is now (it is refetched after changes), for merging a page that arrives later.
  const latestFirst = useRef<NotificationView[]>([]);
  useEffect(() => {
    latestFirst.current = state.data ?? [];
  }, [state.data]);
  const markAll = async () => {
    try {
      await api.post("/me/notifications/mark-all-read");
      readChanges.current = withMarkAll(readChanges.current);
      setOlder((o) => (o ? { ...o, items: o.items.map((n) => ({ ...n, read: true })) } : o));
      toast("Notifications marked read.");
      void state.reload();
    } catch (e) {
      toast((e as ApiError).message);
    }
  };
  const mark = async (n: NotificationView) => {
    const changed = await api.patch<NotificationView>(`/me/notifications/${n.id}`, { read: !n.read }).catch(() => null);
    if (changed) {
      readChanges.current = withMark(readChanges.current, changed.id, changed.read);
      setOlder((o) => replaceInOlder(o, changed));
    }
    void state.reload();
  };
  const loadOlder = async (first: NotificationView[]) => {
    setLoadingOlder(true);
    try {
      const since = readChanges.current.seq;
      const page = await api.getEnvelope<NotificationView[], { has_more: boolean }>(olderPagePath(shownNotifications(first, older)));
      // Changes made while the page was loading win over the page's older read state, and the page is merged into the
      // older pages as they are now, so a Mark Read made meanwhile is kept.
      const items = reconcileReadState(page.data, readChanges.current, since);
      setOlder((current) => withOlderPage(latestFirst.current.length ? latestFirst.current : first, current, items, page.meta.has_more));
      setOlderStatus(page.data.length ? `Loaded ${page.data.length} older notification${page.data.length === 1 ? "" : "s"}.` : "There are no older notifications.");
    } catch (e) {
      toast((e as ApiError).message);
    } finally {
      setLoadingOlder(false);
    }
  };
  return (
    <>
      <PageTitle eyebrow="NOTIFICATIONS" title="Notifications" description="Reminders and learning follow-ups in your authorised scope. In-app only until an external channel is approved." action={<Btn onClick={() => void markAll()}>Mark All Read</Btn>} />
      <section className="panel">
        <Loaded state={state}>
          {(first) =>
            first.length ? (
              <>
                {shownNotifications(first, older).map((n) => (
                  <article className="notification-item" key={n.id}>
                    <span className="course-glyph">
                      <Icon name="bell" />
                    </span>
                    <div className="grow">
                      <h3>{n.title}</h3>
                      <p>{n.message}</p>
                      <small>{dateTime(n.created_at)}</small>
                    </div>
                    <div className="row wrap">
                      {n.link ? <BtnLink href={n.link} kind="text">Open</BtnLink> : null}
                      <Btn kind="text" onClick={() => void mark(n)}>
                        {n.read ? "Mark unread" : "Mark read"}
                      </Btn>
                      <Badge status={n.read ? "Read" : "Unread"} />
                    </div>
                  </article>
                ))}
                {mayHaveOlder(first, older) ? (
                  <div className="row">
                    <Btn disabled={loadingOlder} onClick={() => void loadOlder(first)}>
                      {loadingOlder ? "Loading older notifications…" : "Load older notifications"}
                    </Btn>
                  </div>
                ) : null}
                <p className="sr-only" role="status" aria-live="polite">
                  {olderStatus}
                </p>
              </>
            ) : (
              <Empty title="No notifications yet." hint="Reminders and follow-ups will appear here." />
            )
          }
        </Loaded>
      </section>
    </>
  );
}

export function ProfilePage() {
  const { user } = useSession();
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setError(null);
    if (values.get("next") !== values.get("confirm")) {
      setError(new ApiError(400, "VALIDATION_ERROR", "The new password and its confirmation do not match."));
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/change-password", { current_password: values.get("current"), new_password: values.get("next") });
      toast("Password changed. Your other sessions were signed out.");
      form.reset();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const facts: [string, string | null][] = [
    ["Name", user.full_name],
    ["Work email", user.email],
    ["Employee ID", user.employee_code],
    ["Department", user.department],
    ["Function", user.function],
    ["Location", user.location],
    ["Grade", user.grade],
  ];
  return (
    <>
      <PageTitle eyebrow="ACCOUNT" title="My profile" description="Your details come from the employee record and cannot be changed here." />
      <section className="panel">
        <div className="detail-grid">
          {facts.map(([label, value]) => (
            <div key={label}>
              <small>{label}</small>
              <strong>{value ?? "Not recorded"}</strong>
            </div>
          ))}
        </div>
        <p>
          <strong>Roles:</strong> {user.roles.map((r) => ROLE_LABEL[r]).join(", ")}
        </p>
      </section>
      {/* L&D Admins can change their own password; employees only when the server allows it (EMPLOYEE_PASSWORD_CHANGE_ENABLED). The server enforces it. */}
      {!canChangeOwnPassword(user) ? (
        <section className="panel">
          <h2>Password</h2>
          <p>Your password is managed by L&amp;D and cannot be changed here. If you cannot sign in, contact your L&amp;D Admin.</p>
        </section>
      ) : (
        /* Any edit clears the previous answer, so an old message never describes a new attempt. */
        <form className="panel" onSubmit={(e) => void submit(e)} onInput={() => error && setError(null)}>
          <h2>Change password</h2>
          <TextField label="Current password" name="current" type="password" required autoComplete="current-password" />
          <TextField label="New password" name="next" type="password" required minLength={10} autoComplete="new-password" />
          <TextField label="Confirm new password" name="confirm" type="password" required minLength={10} autoComplete="new-password" />
          <p className="small">Use at least 10 characters with upper-case and lower-case letters and a number.</p>
          {error ? <ErrorPanel error={error} /> : null}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </button>
        </form>
      )}
    </>
  );
}
