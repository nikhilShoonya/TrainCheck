import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const percent = (value: number | null | undefined, missing = "—") => (value === null || value === undefined ? missing : `${formatNumber(value)}%`);

export const formatNumber = (value: number) => value.toFixed(1).replace(/\.0$/, "");

export const orMissing = (value: number | string | null | undefined, missing = "Not collected") => (value === null || value === undefined || value === "" ? missing : String(value));

/** The organisation's timezone. Dates are shown and chosen in it, never as the UTC date of a timestamp
    (which is the previous day for India from 00:00 to 05:30). Matches the backend's working calendar. */
export const ORG_TIMEZONE = process.env.NEXT_PUBLIC_ORG_TIMEZONE || "Asia/Kolkata";
const orgDate = new Intl.DateTimeFormat("en-CA", { timeZone: ORG_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD in the organisation timezone. A plain date (no time) is returned as it is. */
export const day = (iso: string | null | undefined, missing = "Not recorded") => {
  if (!iso) return missing;
  if (iso.length <= 10) return iso;
  const moment = new Date(iso);
  return Number.isNaN(moment.getTime()) ? iso.slice(0, 10) : orgDate.format(moment);
};

/** Today's date in the organisation timezone, for date inputs (defaults, min and max). */
export const todayInOrg = () => orgDate.format(new Date());

export const dateTime = (iso: string | null | undefined, missing = "—") => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : missing);

export const firstName = (name: string) => name.split(" ")[0];

export const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 3);

export const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
};

export const duration = (seconds: number) => `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;

/** "Good morning/afternoon/evening" for the viewer's local time. Only call it in the browser. */
export const greeting = (now: Date = new Date()) => {
  const hour = now.getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
};
