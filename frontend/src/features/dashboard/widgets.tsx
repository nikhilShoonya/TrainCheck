"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Art } from "@/components/shell/Art";
import { Btn, BtnLink } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import type { BehaviourMeans, Summary } from "@/lib/types";
import { formatNumber, greeting, percent } from "@/lib/utils";
import { useState } from "react";

export function Panel({ title, action, className = "", children }: { title: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`panel dashboard-panel ${className}`}>
      <div className="section-heading">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ViewAll({ href, label = "View All" }: { href: string; label?: string }) {
  return (
    <BtnLink href={href} kind="text" className="compact-link">
      {label} <Icon name="arrow" />
    </BtnLink>
  );
}

export function Welcome({ heading, description }: { heading: ReactNode; description: string }) {
  return (
    <section className="reference-welcome">
      <div>
        <h1 tabIndex={-1}>{heading}</h1>
        <p>{description}</p>
      </div>
      <Art file="green-login" box="0 670 845 250" className="reference-office-photo" />
    </section>
  );
}

export function GoodMorning({ name }: { name: string }) {
  return (
    <>
      {greeting()}, {name} <span aria-hidden="true">👋</span>
    </>
  );
}

export function ImageMetrics({ cards }: { cards: [string, string, ReactNode, string, string][] }) {
  return (
    <section className="image-metrics">
      {cards.map(([icon, label, value, colour, definition]) => (
        <article className={`image-metric ${colour}`} key={label}>
          <span className="image-metric-icon">
            <Icon name={icon} />
          </span>
          <div>
            <h2>{label}</h2>
            <strong>{value}</strong>
            <small>{definition}</small>
          </div>
        </article>
      ))}
    </section>
  );
}

/** Two kinds of evidence, kept apart. There is no combined score. */
export function EvidenceTiles({ learning, assessed, behaviour }: { learning: number | null; assessed: number; behaviour: BehaviourMeans | null }) {
  const manager = behaviour?.manager_mean ?? null;
  const self = behaviour?.self_mean ?? null;
  const value = manager ?? self;
  return (
    <div className="level-tiles two-level">
      <div className="level-tile learning">
        <Icon name="cap" />
        <h3>L2 Learning</h3>
        <strong>
          {learning === null ? (
            "—"
          ) : (
            <>
              {formatNumber(learning)}
              <small>%</small>
            </>
          )}
        </strong>
        <span>{learning === null ? "Not collected" : `${assessed} latest results`}</span>
      </div>
      <div className="level-tile behaviour">
        <Icon name="users" />
        <h3>L3 Behaviour</h3>
        <strong>
          {value === null ? (
            "—"
          ) : (
            <>
              {formatNumber(value)}
              <small>/ 5</small>
            </>
          )}
        </strong>
        <span>{value === null ? "Not collected" : manager !== null ? "Manager observations" : "Self-assessments"}</span>
      </div>
    </div>
  );
}

export function EvidenceHelp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Btn kind="icon-btn" onClick={() => setOpen(true)}>
        <Icon name="help" />
        <span className="sr-only">Explain learning and behaviour evidence</span>
      </Btn>
      {open ? (
        <Modal title="Two distinct kinds of evidence" onClose={() => setOpen(false)}>
          <p>
            <strong>L2 Learning</strong> records demonstrated knowledge. <strong>L3 Behaviour</strong> records how the learning is applied at work, through self-assessment.
          </p>
          <p>A quiz pass does not prove behaviour change. Missing evidence is shown as Not collected, never as zero.</p>
        </Modal>
      ) : null}
    </>
  );
}

export function TrainingProgress({ summary }: { summary: Summary }) {
  const pct = summary.assignments ? Math.round((summary.completed / summary.assignments) * 100) : 0;
  const rows: [string, number, string][] = [
    ["Completed", summary.completed, "green"],
    ["Assessment in Progress", summary.in_progress, "purple"],
    ["Not Completed", summary.assignments - summary.completed, "amber"],
  ];
  return (
    <>
      <div className="training-progress">
        <div className="progress-donut" style={{ "--progress": `${pct}%` } as React.CSSProperties} role="img" aria-label={`${summary.completed} of ${summary.assignments} assigned training completed`}>
          <div>
            <strong>{summary.assignments ? `${pct}%` : "—"}</strong>
            <span>Completed</span>
          </div>
        </div>
        <dl>
          {rows.map(([label, value, cls]) => (
            <div key={label}>
              <dt>
                <i className={`dot ${cls}`} />
                {label}
              </dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="card-footnote">Training completion is separate from assessment results.</p>
    </>
  );
}

export function ScorecardCta({ heading, description, href, label = "View Scorecard" }: { heading: string; description: string; href: string; label?: string }) {
  return (
    <section className="image-scorecard-cta">
      <span>
        <Icon name="award" />
      </span>
      <div>
        <h2>{heading}</h2>
        <p>{description}</p>
      </div>
      <BtnLink href={href}>
        {label} <Icon name="arrow" />
      </BtnLink>
    </section>
  );
}

export function ActionItem({ icon, heading, description, href, label, tone }: { icon: string; heading: string; description: string; href: string; label: string; tone?: "attention" }) {
  return (
    <div className="dashboard-action-item">
      <span className="course-glyph">
        <Icon name={icon} />
      </span>
      <div>
        <h3>{heading}</h3>
        <p>{description}</p>
      </div>
      <BtnLink href={href} tone={tone}>
        {label}
      </BtnLink>
    </div>
  );
}

export function DepartmentBars({ departments }: { departments: ({ department: string } & Summary)[] }) {
  if (!departments.length) return <div className="quiet-empty">No departments have assignments yet.</div>;
  return (
    <>
      {departments.map((d) => (
        <div className="image-department-bar" key={d.department}>
          <strong>{d.department}</strong>
          <div>
            <progress max={100} value={d.completion_rate ?? 0} aria-label={`${d.department} completion`} />
            <span>{percent(d.completion_rate)}</span>
          </div>
        </div>
      ))}
    </>
  );
}

export function ScoreTag({ value, threshold = 70 }: { value: number | null | undefined; threshold?: number }) {
  const cls = value === null || value === undefined ? "neutral" : value >= threshold ? "success" : "danger";
  return (
    <span className={`score-tag ${cls}`} data-sort={String(value ?? "")}>
      {percent(value)}
    </span>
  );
}

export function Glyph({ index, icon }: { index: number; icon?: string }) {
  return (
    <span className={`course-glyph glyph-${index % 3}`}>
      <Icon name={icon ?? ["shield", "headphones", "lock"][index % 3]} />
    </span>
  );
}

export function RecentRow({ href, index, title, sub, dot, trailing }: { href: string; index: number; title: string; sub: string; dot: string; trailing: ReactNode }) {
  return (
    <Link className="recent-training" href={href}>
      <Glyph index={index} />
      <span className="recent-training-copy">
        <strong>{title}</strong>
        <small>
          <i className={`dot ${dot}`} />
          {sub}
        </small>
      </span>
      {trailing}
    </Link>
  );
}
