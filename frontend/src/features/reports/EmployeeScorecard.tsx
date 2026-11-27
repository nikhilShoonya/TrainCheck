"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Btn, BtnLink, DataTable, Empty, ErrorPanel, Loading, useToast } from "@/components/ui";
import { ApiError, downloadFile, toQuery } from "@/lib/api";
import { FEEDBACK_LABELS } from "@/lib/feedback";
import { useSession } from "@/lib/hooks";
import { apiQuery } from "@/lib/query";
import { dateTime, day, initials, todayInOrg } from "@/lib/utils";
import {
  attemptText,
  DATE_PRESETS,
  datesProblem,
  firstLatestText,
  gainText,
  isCompleteDay,
  isEmployeeId,
  limitRows,
  needsExpansion,
  parseScorecardFilters,
  presetOf,
  presetRange,
  ratingText,
  reportsHref,
  ROW_LIMIT,
  scopeText,
  scorecardHref,
  scoreText,
  showingLabel,
  TYPE_LABEL,
  viewAllLabel,
  type DatePreset,
  type EmployeeScorecardData,
  type FeedbackItem,
  type FeedbackKey,
  type GainItem,
  type ScorecardFilters,
} from "./employeeScorecardView";

const NOT_RECORDED = "Not recorded";

/** Zero-padded so text sorting orders scores numerically (69.25 before 69.5); missing scores sort first. */
const sortKey = (value: number | null) => (value === null ? "" : value.toFixed(2).padStart(6, "0"));

/** L&D Admin: one employee's complete learning record, opened from an employee row in Reports & Analytics. */
export function EmployeeScorecard() {
  return (
    <Suspense fallback={<Loading />}>
      <EmployeeScorecardInner />
    </Suspense>
  );
}

function Heading({ title, description, backHref, action }: { title: string; description: string; backHref: string; action: ReactNode }) {
  return (
    <div className="page-heading esc-heading">
      <div>
        <div className="eyebrow">L&amp;D ADMIN</div>
        <nav className="esc-breadcrumb" aria-label="Breadcrumb">
          <Link href={backHref}>Reports &amp; Analytics</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Employee Scorecard</span>
        </nav>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function EmployeeScorecardInner() {
  const { employeeId } = useParams<{ employeeId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const { user } = useSession();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const filters = parseScorecardFilters(params);
  const back = params.get("back") ?? "";
  const backHref = reportsHref(back);
  const valid = isEmployeeId(employeeId);
  const path = valid ? `/reports/employees/${employeeId}/scorecard${toQuery({ ...filters })}` : "";
  // The last scorecard stays on screen while a new filter loads, so the page and its controls do not jump.
  const query = useQuery({ ...apiQuery<EmployeeScorecardData>(user?.id, path), enabled: valid, placeholderData: keepPreviousData });
  const data = query.data ?? null;
  const error = (query.error as ApiError | null) ?? null;

  const applyFilters = (next: ScorecardFilters) => router.replace(scorecardHref(employeeId, back || undefined, next), { scroll: false });
  const exportPdf = async () => {
    setExporting(true);
    try {
      await downloadFile(`/reports/employees/${employeeId}/scorecard/pdf${toQuery({ ...filters })}`, "employee-scorecard.pdf");
      toast("Scorecard exported with every record that matches the current filters.");
    } catch (e) {
      toast((e as ApiError).message);
    } finally {
      setExporting(false);
    }
  };

  const backButton = (
    <BtnLink href={backHref} tone="data">
      <Icon name="back" /> Back to report
    </BtnLink>
  );

  if (!valid || (error?.status === 404 && !data)) {
    return (
      <>
        <Heading title="Employee not found" description="This employee does not exist, was removed, or is not covered by reports." backHref={backHref} action={<div className="page-actions">{backButton}</div>} />
        <Empty title="No employee has this link." hint="Go back to the report and choose an employee from the table." />
      </>
    );
  }

  const actions = (
    <div className="page-actions">
      {backButton}
      <Btn kind="primary" className="esc-export" onClick={() => void exportPdf()} disabled={!data || exporting || query.isFetching}>
        <Icon name="file" /> {exporting ? "Preparing…" : "Export PDF"}
      </Btn>
    </div>
  );

  return (
    <>
      <Heading title="Employee Scorecard" description="Complete learning record across all assigned trainings." backHref={backHref} action={actions} />
      {!data ? (
        error ? (
          <>
            <ErrorPanel error={error} retry={() => void query.refetch()} />
            {Object.keys(filters).length ? (
              <Btn kind="text" onClick={() => applyFilters({})}>
                Reset filters
              </Btn>
            ) : null}
          </>
        ) : (
          <Loading label="Loading the scorecard…" />
        )
      ) : (
        <>
          {error ? (
            <div className="notice danger" role="alert">
              {error.message}{" "}
              <Btn kind="text" onClick={() => applyFilters({})}>
                Reset filters
              </Btn>
            </div>
          ) : null}
          {query.isFetching ? (
            <span className="tc-refreshing" role="status" aria-live="polite">
              Updating…
            </span>
          ) : null}
          <Profile card={data} />
          <FilterBar card={data} filters={filters} onApply={applyFilters} />
          {/* Keyed by the filters: a new selection starts every table again at five rows. */}
          <ScorecardBody key={toQuery({ ...filters })} card={data} filters={filters} />
        </>
      )}
    </>
  );
}

function Value({ value }: { value: ReactNode }) {
  return value === null || value === undefined || value === "" ? <span className="muted">{NOT_RECORDED}</span> : <>{value}</>;
}

function Profile({ card }: { card: EmployeeScorecardData }) {
  const e = card.employee;
  const facts: [string, ReactNode][] = [
    ["Employee ID", e.employee_code],
    ["Department", e.department],
    ["Location", e.location],
    ["Grade", e.grade],
    ["Joining date", e.joining_date ? day(e.joining_date) : null],
    ["Email", e.email],
  ];
  return (
    <section className="panel esc-profile" aria-label="Employee profile">
      <div className="esc-person">
        <span className="esc-avatar" aria-hidden="true">
          {initials(e.name).slice(0, 2).toUpperCase()}
        </span>
        <h2>{e.name}</h2>
      </div>
      <dl className="esc-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <Value value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Training and Date apply as soon as they change. Date is the training completion date: a preset range, or a
    custom range whose two dates apply once each is a complete date. Reset clears both. */
function FilterBar({ card, filters, onApply }: { card: EmployeeScorecardData; filters: ScorecardFilters; onApply: (f: ScorecardFilters) => void }) {
  const today = todayInOrg();
  const current = presetOf(filters, today);
  const [custom, setCustom] = useState(current === "custom");
  const [from, setFrom] = useState(filters.date_from ?? "");
  const [to, setTo] = useState(filters.date_to ?? "");
  const [error, setError] = useState("");
  const preset: DatePreset = custom ? "custom" : current;

  const choose = (value: DatePreset) => {
    setError("");
    if (value === "custom") {
      setCustom(true);
      setFrom(filters.date_from ?? "");
      setTo(filters.date_to ?? "");
      return;
    }
    setCustom(false);
    onApply({ training_id: filters.training_id, ...presetRange(value, today) });
  };
  const typed = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    if ((nextFrom && !isCompleteDay(nextFrom)) || (nextTo && !isCompleteDay(nextTo))) return;
    const next: ScorecardFilters = { training_id: filters.training_id, date_from: nextFrom || undefined, date_to: nextTo || undefined };
    const problem = datesProblem(next);
    setError(problem ?? "");
    if (!problem) onApply(next);
  };
  const reset = () => {
    setCustom(false);
    setFrom("");
    setTo("");
    setError("");
    onApply({});
  };

  return (
    <section className="panel esc-filter-bar" aria-label="Scorecard filters">
      <label className="esc-inline esc-training">
        <span>Training</span>
        <select name="training_id" value={filters.training_id ?? ""} onChange={(e) => onApply({ ...filters, training_id: e.target.value || undefined })}>
          <option value="">All trainings</option>
          {card.training_options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="esc-inline esc-date">
        <span>Date</span>
        <select name="date_preset" value={preset} onChange={(e) => choose(e.target.value as DatePreset)} aria-describedby="esc-date-basis" title={card.date_basis}>
          {DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {preset === "custom" ? (
        <>
          <label className="esc-inline esc-day">
            <span>From</span>
            <input type="date" name="date_from" value={from} max={to || undefined} onChange={(e) => typed(e.target.value, to)} />
          </label>
          <label className="esc-inline esc-day">
            <span>To</span>
            <input type="date" name="date_to" value={to} min={from || undefined} onChange={(e) => typed(from, e.target.value)} />
          </label>
        </>
      ) : null}
      <button type="button" className="esc-reset" onClick={reset}>
        Reset
      </button>
      <span id="esc-date-basis" className="sr-only">
        {card.date_basis}
      </span>
      {error ? (
        <p className="form-error esc-filter-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ScorecardBody({ card, filters }: { card: EmployeeScorecardData; filters: ScorecardFilters }) {
  const scope = scopeText(filters, (iso) => day(iso));
  const s = card.summary;
  return (
    <>
      <div className="esc-summary" role="list" aria-label="Summary">
        <SummaryTile icon="book" tone="data" label="Assigned trainings" value={s.assigned} />
        <SummaryTile icon="checkCircle" tone="success" label="Completed trainings" value={s.completed} />
        <SummaryTile icon="award" tone="data" label="Passed assessments" value={s.passed} />
        <SummaryTile icon="alert" tone="attention" label="Overdue assessments" value={s.overdue} highlight />
      </div>
      <p className="esc-note">
        <Icon name="info" /> Training completion and assessment outcomes are tracked separately.
      </p>
      <TrainingRecord card={card} scope={scope} />
      <div className="esc-grid">
        <LearningGain items={card.learning_gain} scope={scope} />
        <Feedback items={card.feedback} />
      </div>
      <AttemptHistory card={card} scope={scope} />
      <div className="esc-generated">
        <span>Generated {dateTime(card.generated_at)}</span>
      </div>
    </>
  );
}

function SummaryTile({ icon, tone, label, value, highlight }: { icon: string; tone: "data" | "success" | "attention"; label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`esc-tile tone-${tone}${highlight ? " highlight" : ""}`} role="listitem">
      <Icon name={icon} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** A card whose list first shows five records. "View all (N)" (top right) shows the rest; "Show less" returns to
    five. The control is absent when there are five or fewer. `countAlways={false}` shows the count line only when
    some records are hidden (the reference's Learning gain and Feedback cards have none otherwise). */
function LimitedCard({ id, title, total, expanded, onToggle, singular, plural, detail, countAlways = true, children, footnote, className = "" }: { id: string; title: string; total: number; expanded: boolean; onToggle: () => void; singular: string; plural?: string; detail?: string; countAlways?: boolean; children: ReactNode; footnote?: ReactNode; className?: string }) {
  const expandable = needsExpansion(total);
  return (
    <section className={`panel esc-card ${className}`.trim()} aria-labelledby={`${id}-title`}>
      <div className="esc-card-head">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {countAlways || expandable ? (
            <p className="esc-count" id={`${id}-count`} aria-live="polite">
              {showingLabel(total, expanded, singular, plural)}
              {detail ? ` · ${detail}` : ""}
            </p>
          ) : null}
        </div>
        {expandable ? (
          <Btn tone="data" className="esc-view-all" aria-expanded={expanded} aria-controls={`${id}-body`} onClick={onToggle}>
            {viewAllLabel(total, expanded)}
          </Btn>
        ) : null}
      </div>
      <div id={`${id}-body`}>{children}</div>
      {footnote ? (
        <p className="esc-footnote">
          <Icon name="info" /> {footnote}
        </p>
      ) : null}
    </section>
  );
}

function useExpanded() {
  const [expanded, setExpanded] = useState(false);
  return { expanded, toggle: () => setExpanded((e) => !e) };
}

function TrainingRecord({ card, scope }: { card: EmployeeScorecardData; scope: string }) {
  const { expanded, toggle } = useExpanded();
  const rows = card.trainings.map((t) => [
    t.training,
    day(t.assigned_at),
    t.completed_at ? day(t.completed_at) : "Not completed",
    <span key="fl" data-sort={sortKey(t.first_score)}>
      {firstLatestText(t.first_score, t.latest_score)}
    </span>,
    <strong key="hi" className={t.highest_score === null ? "esc-missing" : "esc-highest"} data-sort={sortKey(t.highest_score)}>
      {scoreText(t.highest_score)}
    </strong>,
    t.attempts,
    t.assessment_timing === "Overdue" ? (
      <span key="timing" className="badge esc-overdue" data-sort="Overdue">
        Overdue
      </span>
    ) : (
      t.assessment_timing
    ),
    t.result,
  ]);
  return (
    <LimitedCard id="training-record" className="esc-record" title="Training record" total={rows.length} expanded={expanded} onToggle={toggle} singular="training" detail={scope} footnote="Highest score = best post-test score across all attempts, including re-training cycles.">
      <DataTable
        headers={["Training", "Assigned", "Completed", "First / Latest %", "Highest Score %", "Attempts", "Assessment timing", "Result"]}
        rows={rows}
        maxRows={expanded ? rows.length : ROW_LIMIT}
        emptyTitle="No trainings match these filters."
        emptyHint="Change the training or date, or choose Reset."
      />
    </LimitedCard>
  );
}

function GainRow({ item }: { item: GainItem }) {
  const width = (value: number | null) => `${Math.max(0, Math.min(100, value ?? 0))}%`;
  return (
    <li className="esc-gain">
      <span className="esc-gain-title">{item.training}</span>
      <div className="esc-gain-bars" aria-label={`Pre-test ${scoreText(item.pre_test)}, first post-test ${scoreText(item.first_post_test)}`}>
        <span className="esc-bar" aria-hidden="true">
          {item.pre_test !== null ? <i className="pre" style={{ width: width(item.pre_test) }} /> : null}
        </span>
        <span className="esc-bar-value">{scoreText(item.pre_test)}</span>
        <span className="esc-bar" aria-hidden="true">
          {item.first_post_test !== null ? <i className="post" style={{ width: width(item.first_post_test) }} /> : null}
        </span>
        <span className="esc-bar-value">{scoreText(item.first_post_test)}</span>
      </div>
      <span className={`esc-gain-chip${item.comparable ? "" : " none"}`} title={item.note ?? undefined}>
        {item.comparable ? (
          <>
            <span>Gain</span> <span>{gainText(item)}</span>
          </>
        ) : (
          <>
            <span>Not</span> <span>comparable</span>
          </>
        )}
      </span>
    </li>
  );
}

function LearningGain({ items, scope }: { items: GainItem[]; scope: string }) {
  const { expanded, toggle } = useExpanded();
  return (
    <LimitedCard id="learning-gain" className="esc-gain-card" title="Learning gain" total={items.length} expanded={expanded} onToggle={toggle} singular="training" detail={scope} countAlways={false} footnote="Compared only where both tests exist. Missing scores are not zero.">
      {items.length ? (
        <>
          <div className="esc-legend" aria-hidden="true">
            <span>
              <i className="pre" /> Pre-test
            </span>
            <span>
              <i className="post" /> First post-test
            </span>
          </div>
          <ul className="esc-list">
            {limitRows(items, expanded).map((item) => (
              <GainRow key={item.training_id} item={item} />
            ))}
          </ul>
        </>
      ) : (
        <Empty title="No trainings match these filters." hint="Learning gain appears for each training in the record above." />
      )}
    </LimitedCard>
  );
}

const feedbackTitle = (item: FeedbackItem) => `${item.training}${item.show_cycle ? ` · Cycle ${item.training_cycle}` : ""}`;

/** As in the reference: choose a training to read its feedback; below, the assessments still without feedback. */
function Feedback({ items }: { items: FeedbackItem[] }) {
  const submitted = items.filter((i) => i.status === "SUBMITTED" && i.ratings);
  const missing = items.filter((i) => !(i.status === "SUBMITTED" && i.ratings));
  const [selected, setSelected] = useState(0);
  const { expanded, toggle } = useExpanded();
  const item = submitted[Math.min(selected, submitted.length - 1)];
  return (
    <LimitedCard id="training-feedback" className="esc-feedback-card" title="Training feedback" total={missing.length} expanded={expanded} onToggle={toggle} singular="training without feedback" plural="trainings without feedback" countAlways={false}>
      {!items.length ? (
        <Empty title="No feedback for these filters." hint="Feedback is asked after a post-test result." />
      ) : (
        <>
          {item ? (
            <div className="esc-feedback">
              <label className="esc-feedback-select">
                <span className="sr-only">Feedback for training</span>
                <select value={String(Math.min(selected, submitted.length - 1))} onChange={(e) => setSelected(Number(e.target.value))}>
                  {submitted.map((f, i) => (
                    <option key={`${f.training_id}-${f.training_cycle}`} value={i}>
                      {feedbackTitle(f)}
                    </option>
                  ))}
                </select>
              </label>
              <dl className="esc-feedback-facts">
                <div>
                  <dt>Overall feedback</dt>
                  <dd>
                    <strong>{ratingText(item.overall)}</strong> / 5
                  </dd>
                </div>
                <div>
                  <dt>Submitted</dt>
                  <dd>{dateTime(item.submitted_at)}</dd>
                </div>
                <div>
                  <dt>Ratings</dt>
                  <dd className="esc-ratings">
                    {(Object.keys(item.ratings!) as FeedbackKey[]).map((key) => (
                      <span key={key}>
                        {FEEDBACK_LABELS[key]} <strong>{item.ratings![key]}</strong>
                      </span>
                    ))}
                  </dd>
                </div>
              </dl>
              <p className="esc-comment">{item.comment ? item.comment : <span className="muted">No comment</span>}</p>
            </div>
          ) : (
            <p className="esc-feedback-none">No feedback submitted yet.</p>
          )}
          {missing.length ? (
            <ul className="esc-list esc-feedback-missing">
              {limitRows(missing, expanded).map((m) => (
                <li key={`${m.training_id}-${m.training_cycle}`}>
                  <strong>{feedbackTitle(m)}</strong>
                  <span>{m.status === "NOT_REQUIRED" ? "Not required" : "Not submitted"}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </LimitedCard>
  );
}

function AttemptHistory({ card, scope }: { card: EmployeeScorecardData; scope: string }) {
  const { expanded, toggle } = useExpanded();
  const rows = card.attempts.map((a) => [
    a.training,
    TYPE_LABEL[a.assessment_type],
    <span key="attempt" data-sort={`${String(a.training_cycle).padStart(3, "0")}-${String(a.attempt_number).padStart(3, "0")}`}>
      {attemptText(a)}
    </span>,
    <span key="score" data-sort={sortKey(a.score)}>
      {scoreText(a.score)}
    </span>,
    a.result === "BASELINE" ? (
      <span key="result" className="badge neutral" data-sort="Baseline">
        Baseline
      </span>
    ) : (
      a.result
    ),
    dateTime(a.submitted_at),
    a.submission,
  ]);
  return (
    <LimitedCard id="attempt-history" className="esc-history" title="Assessment attempt history" total={rows.length} expanded={expanded} onToggle={toggle} singular="attempt" detail={scope === "all time" ? "every attempt is retained" : `${scope} · every attempt is retained`}>
      <DataTable
        headers={["Training", "Type", "Attempt", "Score", "Result", "Submitted", "Submission"]}
        rows={rows}
        maxRows={expanded ? rows.length : ROW_LIMIT}
        emptyTitle="No submitted attempts for these filters."
        emptyHint="Attempts appear here once a pre-test or post-test is submitted."
      />
    </LimitedCard>
  );
}
