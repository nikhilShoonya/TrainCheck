"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Icon } from "@/components/icons";
import type { TrendPoint } from "@/lib/types";

/* Series colours come from the prototype's trend chart. Identity is also carried by the legend and tooltip text. */
const COMPLETION = "#108550";
const PASS = "#284e76";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
const axis = { fontSize: 11, fill: "#46546c" };

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number | null; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tc-chart-tooltip">
      <strong>{label}</strong>
      {payload.map((p) => (
        <span key={p.name}>
          <i style={{ background: p.color }} />
          {p.name}: {p.value === null ? "Not collected" : `${p.value}%`}
        </span>
      ))}
    </div>
  );
}

export function MonthlyTrend({ points, dual = false }: { points: TrendPoint[]; dual?: boolean }) {
  if (!points.length) return <div className="chart-empty">No dated training evidence yet.</div>;
  const data = points.map((p) => ({ label: monthLabel(p.month), completion: p.completion_rate, pass: p.pass_rate }));
  const summary = points.map((p) => `${p.month}: completion ${p.completion_rate ?? "not collected"}%, pass rate ${p.pass_rate ?? "not collected"}%`).join("; ");
  return (
    <figure className="monthly-trend">
      {dual ? (
        <div className="trend-legend">
          <span>
            <i className="purple" />
            Completion
          </span>
          <span>
            <i className="green" />
            Pass Rate
          </span>
        </div>
      ) : null}
      <div role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height={170}>
          <AreaChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: -14 }}>
            <CartesianGrid vertical={false} stroke="#edf0f2" />
            <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
            <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={axis} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTooltip />} />
            {dual ? <Area name="Completion" type="linear" dataKey="completion" stroke={COMPLETION} fill={COMPLETION} fillOpacity={0.08} strokeWidth={2} dot={{ r: 3.5, fill: "#fff", strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} /> : null}
            <Area name="Pass rate" type="linear" dataKey="pass" stroke={dual ? PASS : COMPLETION} fill={dual ? PASS : COMPLETION} fillOpacity={0.08} strokeWidth={2} dot={{ r: 3.5, fill: "#fff", strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <figcaption>{points.length === 1 ? "One recorded month; no time trend inferred." : "Recorded months only; missing months are not zeros."}</figcaption>
    </figure>
  );
}

export interface ScorePoint {
  label: string;
  score: number | null;
  date: string;
}

export function ScoreTrend({ points, spark = false }: { points: ScorePoint[]; spark?: boolean }) {
  if (!points.length) {
    return (
      <div className="chart-empty">
        <Icon name="chart" />
        <span>No submitted assessments yet</span>
      </div>
    );
  }
  const colour = COMPLETION;
  const summary = points.map((p) => `${p.label}: ${p.score}%`).join("; ");
  return (
    <figure className={`performance-figure${spark ? " sparkline" : ""}`}>
      <div role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height={spark ? 74 : 130}>
          <AreaChart data={points} margin={spark ? { top: 6, right: 4, bottom: 4, left: 4 } : { top: 10, right: 12, bottom: 0, left: -14 }}>
            {spark ? null : <CartesianGrid vertical={false} stroke="#edf0f2" />}
            {spark ? null : <XAxis dataKey="date" tick={false} tickLine={false} axisLine={false} />}
            <YAxis hide={spark} domain={[0, 100]} ticks={[0, 50, 100]} tick={axis} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} />
            <Tooltip content={({ active, payload }) => (active && payload?.length ? <div className="tc-chart-tooltip"><strong>{payload[0].payload.label}</strong><span>{payload[0].value}%</span></div> : null)} />
            <Area type="linear" dataKey="score" stroke={colour} fill={colour} fillOpacity={0.1} strokeWidth={2} dot={{ r: spark ? 2 : 3, fill: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <figcaption className={spark ? "sr-only" : undefined}>
        {points.length} latest training result(s), ordered by submission. {points.length === 1 ? "One point; no trend inferred." : ""}
      </figcaption>
    </figure>
  );
}
