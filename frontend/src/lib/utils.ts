export const percent = (value: number | null | undefined, missing = "—") => (value === null || value === undefined ? missing : `${formatNumber(value)}%`);

export const formatNumber = (value: number) => value.toFixed(1).replace(/\.0$/, "");

/** Human-visible dates always use India time. API timestamps and native input values keep their wire formats. */
export const ORG_TIMEZONE = "Asia/Kolkata";
const orgDate = new Intl.DateTimeFormat("en-CA", { timeZone: ORG_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** DD-MM-YYYY for display. Date-only values are calendar dates, never timezone-shifted. */
export const day = (iso: string | null | undefined, missing = "Not recorded") => {
  if (!iso) return missing;
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (plain) return `${plain[3]}-${plain[2]}-${plain[1]}`;
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return iso;
  const p = partsIn(ORG_TIMEZONE, moment);
  return `${p.day}-${p.month}-${p.year}`;
};

/** Cards use the same date format as tables. */
export const longDay = day;

/** Today's date in the organisation timezone, for date inputs (defaults, min and max). */
export const todayInOrg = () => orgDate.format(new Date());

const zoned = new Map<string, Intl.DateTimeFormat>();
function partsIn(timezone: string, moment: Date): Record<string, string> {
  let format = zoned.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    zoned.set(timezone, format);
  }
  return Object.fromEntries(format.formatToParts(moment).map((p) => [p.type, p.value]));
}

/** India time, DD-MM-YYYY hh:mm AM/PM, with no timezone suffix. */
export const dateTime = (iso: string | null | undefined, missing = "—") => {
  if (!iso) return missing;
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return iso;
  const p = partsIn(ORG_TIMEZONE, moment);
  const hour = Number(p.hour);
  return `${p.day}-${p.month}-${p.year} ${String(hour % 12 || 12).padStart(2, "0")}:${p.minute} ${hour < 12 ? "AM" : "PM"}`;
};

/** Kept for existing callers; server/calendar timezone never changes the India-only display. */
export const dateTimeIn = (iso: string | null | undefined, _timezone?: string | null, missing = "Not recorded") => dateTime(iso, missing);

/** Today (YYYY-MM-DD) and the current time (HH:MM) in a timezone, for date and time inputs. */
export const nowIn = (timezone?: string | null, at: Date = new Date()) => {
  const p = partsIn(timezone || ORG_TIMEZONE, at);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};

/** Chronological sorting for human date strings, including month/year boundaries and noon/midnight. */
export const compareTableValues = (left: string, right: string) => {
  const key = (text: string) => {
    const m = /^(\d{2})-(\d{2})-(\d{4})(?: (\d{2}):(\d{2}) (AM|PM))?$/.exec(text);
    if (!m) return null;
    const hour = m[4] ? Number(m[4]) % 12 + (m[6] === "PM" ? 12 : 0) : 0;
    return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), hour, Number(m[5] ?? 0));
  };
  const a = key(left), b = key(right);
  return a !== null && b !== null ? a - b : left.localeCompare(right, "en", { numeric: true });
};

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

/** The greeting follows India time too, regardless of the device timezone. */
export const greeting = (now: Date = new Date()) => {
  const hour = Number(partsIn(ORG_TIMEZONE, now).hour);
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
};
