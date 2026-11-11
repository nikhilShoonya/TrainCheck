import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const percent = (value: number | null | undefined, missing = "—") => (value === null || value === undefined ? missing : `${formatNumber(value)}%`);

export const formatNumber = (value: number) => value.toFixed(1).replace(/\.0$/, "");

export const orMissing = (value: number | string | null | undefined, missing = "Not collected") => (value === null || value === undefined || value === "" ? missing : String(value));

export const day = (iso: string | null | undefined, missing = "Not recorded") => (iso ? iso.slice(0, 10) : missing);

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
