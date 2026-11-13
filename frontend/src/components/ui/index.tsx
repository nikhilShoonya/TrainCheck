"use client";

import { Slot } from "@radix-ui/react-slot";
import Link from "next/link";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { ApiError } from "@/lib/api";
import { formatNumber } from "@/lib/utils";

/* ---------- Toast ---------- */

const ToastContext = createContext<(message: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((text: string) => {
    setMessage(text);
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 4500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div id="toast" className={`toast${visible ? " visible" : ""}`} role="status" aria-live="polite">
        {message}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- Buttons. Colour follows purpose, as in the prototype's button-tones.css. ---------- */

export type Tone = "danger" | "data" | "attention" | "success";

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: "primary" | "secondary" | "text" | "wide" | "icon-btn";
  tone?: Tone;
  asChild?: boolean;
  large?: boolean;
}

export function Btn({ kind = "secondary", tone, asChild, large, className = "", type = "button", ...props }: BtnProps) {
  const Comp = asChild ? Slot : "button";
  const classes = kind === "icon-btn" ? `icon-btn ${className}` : `btn ${kind === "wide" ? "primary wide" : kind}${large ? " large" : ""}${tone ? ` tone-${tone}` : ""} ${className}`;
  return <Comp className={classes.trim()} {...(asChild ? {} : { type })} {...props} />;
}

export function BtnLink({ href, kind = "secondary", tone, children, className = "" }: { href: string; kind?: "primary" | "secondary" | "text"; tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={`btn ${kind}${tone ? ` tone-${tone}` : ""} ${className}`.trim()}>
      {children}
    </Link>
  );
}

/* ---------- Status. Text always accompanies colour. ---------- */

const BADGE_LABELS: Record<string, [string, string]> = {
  PASSED: ["✓ Passed", "success"],
  NOT_PASSED: ["! Not Passed", "danger"],
  NEEDS_RETRAINING: ["Needs Re-training", "danger"],
  PENDING: ["Pending", "info"],
  NOT_DUE: ["Not Yet Due", "info"],
  OVERDUE: ["Overdue", "danger"],
  SUBMITTED: ["Submitted", "success"],
  CANCELLED: ["Cancelled", "info"],
  ACTIVE: ["Active", "success"],
  DRAFT: ["Draft", "info"],
  ARCHIVED: ["Archived", "info"],
  INACTIVE: ["Inactive", "info"],
  Available: ["Available", "success"],
  "Not yet due": ["Not yet due", "info"],
  "Not configured": ["Not configured", "info"],
  "Not collected": ["Not collected", "info"],
  Incomplete: ["Incomplete", "warning"],
  Read: ["Read", "info"],
  Unread: ["Unread", "warning"],
};

export function Badge({ status }: { status: string }) {
  const [label, tone] = BADGE_LABELS[status] ?? [status, "info"];
  return <span className={`badge ${tone}`}>{label}</span>;
}

export function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: ReactNode; description: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Empty({ title = "No records match your filters.", hint = "Try a different filter or return after data is available." }: { title?: string; hint?: string }) {
  return (
    <div className="empty">
      <Icon name="file" />
      <h3>{title}</h3>
      <p>{hint}</p>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="quiet-empty" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function ErrorPanel({ error, retry }: { error: ApiError | Error; retry?: () => void }) {
  const reference = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="notice danger" role="alert">
      <div>
        <strong>{error.message}</strong>
        {reference ? <p className="small">Reference: {reference}</p> : null}
        {retry ? (
          <Btn kind="secondary" onClick={retry}>
            Try again
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

/** Loading, error and empty handling in one place, so no screen forgets them. */
/** Initial loading, error, empty and loaded states. Data already on screen stays visible while it is
    refreshed in the background, and if that refresh fails. */
export function Loaded<T>({ state, children, empty }: { state: { data: T | null; error: ApiError | null; loading: boolean; refreshing?: boolean; reload: () => void }; children: (data: T) => ReactNode; empty?: (data: T) => boolean }) {
  if (state.data === null) return state.error ? <ErrorPanel error={state.error} retry={state.reload} /> : <Loading />;
  return (
    <>
      {state.error && !state.refreshing ? (
        <div className="notice tc-stale-notice" role="status">
          This information could not be refreshed, so you are seeing the last loaded version. {state.error.message}{" "}
          <Btn kind="text" onClick={() => void state.reload()}>
            Try again
          </Btn>
        </div>
      ) : null}
      {state.refreshing ? (
        <span className="tc-refreshing" role="status" aria-live="polite">
          Updating…
        </span>
      ) : null}
      {empty?.(state.data) ? <Empty /> : children(state.data)}
    </>
  );
}

export function Metrics({ items }: { items: [string, ReactNode, string][] }) {
  return (
    <div className="metrics">
      {items.map(([label, value, note]) => (
        <div key={label}>
          <span className="muted">{label}</span>
          <strong>{value}</strong>
          <small>{note}</small>
        </div>
      ))}
    </div>
  );
}

/* ---------- Form fields ---------- */

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

export function TextField({ label, ...props }: { label: ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label}>
      <input {...props} />
    </Field>
  );
}

export function SelectField({ label, options, placeholder, ...props }: { label: ReactNode; options: { value: string; label: string }[]; placeholder?: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label}>
      <select {...props}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function FormError({ message }: { message: string }) {
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
  );
}

export function fieldErrors(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details;
    if (Array.isArray(details) && details.length) {
      const list = details as { field?: string; message: string }[];
      return list.map((d) => (d.field ? `${d.field.replaceAll("_", " ")}: ${d.message}` : d.message)).join(" ");
    }
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

/* ---------- Tables: sort and eight rows per page, as in the prototype ---------- */

type Cell = ReactNode;
const PAGE_SIZE = 8;

function plain(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(plain).join(" ");
  if (typeof value === "object" && "props" in (value as object)) {
    const props = (value as { props: Record<string, unknown> }).props;
    return String(props["data-sort"] ?? props.status ?? plain(props.children));
  }
  return "";
}

function renderCell(cell: Cell): ReactNode {
  if (cell === "PASSED" || cell === "NOT_PASSED" || cell === "NEEDS_RETRAINING" || cell === "PENDING") return <Badge status={cell as string} />;
  return typeof cell === "number" ? formatNumber(cell) : cell;
}

export function DataTable({ headers, rows, all, emptyTitle, emptyHint }: { headers: string[]; rows: Cell[][]; all?: boolean; emptyTitle?: string; emptyHint?: string }) {
  const [sort, setSort] = useState<{ index: number; descending: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => plain(a[sort.index]).localeCompare(plain(b[sort.index]), "en", { numeric: true }) * (sort.descending ? -1 : 1));
  }, [rows, sort]);

  if (!rows.length) return <Empty title={emptyTitle} hint={emptyHint} />;
  const size = all ? Math.max(1, rows.length) : PAGE_SIZE;
  const pages = Math.ceil(sorted.length / size);
  const current = Math.min(page, pages - 1);
  const visible = sorted.slice(current * size, (current + 1) * size);
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {headers.map((header, i) => (
                <th key={`${header}-${i}`} scope="col" aria-sort={sort?.index === i ? (sort.descending ? "descending" : "ascending") : undefined}>
                  {header && !all ? (
                    <button
                      type="button"
                      className="table-sort"
                      aria-label={`Sort by ${header}`}
                      onClick={() => {
                        setSort((s) => ({ index: i, descending: s?.index === i ? !s.descending : false }));
                        setPage(0);
                      }}
                    >
                      {header}
                      <Icon name="sort" />
                    </button>
                  ) : (
                    header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{renderCell(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > size ? (
        <div className="table-pagination">
          <span>
            Showing {current * size + 1}–{Math.min((current + 1) * size, rows.length)} of {rows.length}
          </span>
          <div>
            <Btn disabled={current === 0} onClick={() => setPage(current - 1)}>
              Previous
            </Btn>
            <span>
              Page {current + 1} of {pages}
            </span>
            <Btn disabled={current === pages - 1} onClick={() => setPage(current + 1)}>
              Next
            </Btn>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function Person({ name }: { name: string }) {
  return (
    <div className="person" data-sort={name}>
      <span className="avatar">
        {name
          .split(" ")
          .map((n) => n[0])
          .join("")}
      </span>
      <strong>{name}</strong>
    </div>
  );
}
