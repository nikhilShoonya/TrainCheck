"use client";

import { useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { ROLE_LABEL } from "@/components/shell/nav";
import { Badge, Btn, BtnLink, Empty, ErrorPanel, Loaded, PageTitle, TextField, useToast } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useApi, useSession } from "@/lib/hooks";
import { dateTime } from "@/lib/utils";

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
  const markAll = async () => {
    try {
      await api.post("/me/notifications/mark-all-read");
      toast("Notifications marked read.");
      void state.reload();
    } catch (e) {
      toast((e as ApiError).message);
    }
  };
  const mark = async (n: NotificationView) => {
    await api.patch(`/me/notifications/${n.id}`, { read: !n.read }).catch(() => {});
    void state.reload();
  };
  return (
    <>
      <PageTitle eyebrow="NOTIFICATIONS" title="Notifications" description="Reminders and learning follow-ups in your authorised scope. In-app only until an external channel is approved." action={<Btn onClick={() => void markAll()}>Mark All Read</Btn>} />
      <section className="panel">
        <Loaded state={state}>
          {(items) =>
            items.length ? (
              <>
                {items.map((n) => (
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
  if (!user) return null;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setError(null);
    try {
      await api.post("/auth/change-password", { current_password: values.get("current"), new_password: values.get("next") });
      toast("Password changed. Your other sessions were signed out.");
      form.reset();
    } catch (e) {
      setError(e as ApiError);
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
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <h2>Change password</h2>
        <TextField label="Current password" name="current" type="password" required autoComplete="current-password" />
        <TextField label="New password" name="next" type="password" required minLength={10} autoComplete="new-password" />
        <p className="small">Use at least 10 characters with upper-case and lower-case letters and a number.</p>
        {error ? <ErrorPanel error={error} /> : null}
        <button className="btn primary" type="submit">
          Change password
        </button>
      </form>
    </>
  );
}
