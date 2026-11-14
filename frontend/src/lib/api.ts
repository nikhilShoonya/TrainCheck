/* The one API client. The browser never decides access: it follows the codes the backend returns. */

const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|; )tc_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

type MutationListener = (path: string) => void;
const mutationListeners: MutationListener[] = [];

/** Called after every successful change (POST, PUT, PATCH, DELETE) so cached screens can refresh. */
export function onApiMutation(listener: MutationListener): void {
  mutationListeners.push(listener);
}

/** A deliberate full page load, not client navigation: in-memory data from the old session is dropped and
    the session and gate decision are read again from the server. Router navigation would keep both. */
export function reloadAt(path: string): void {
  window.location.href = path;
}

function handleAccessCodes(error: ApiError): void {
  if (typeof window === "undefined") return;
  const { pathname } = window.location;
  if (error.code === "UNAUTHENTICATED" && pathname !== "/login") reloadAt("/login");
  if (error.code === "ASSESSMENT_REQUIRED" && !pathname.startsWith("/access/")) reloadAt("/access/assessment-required");
  const owed = (error.details as { attempt_id?: string } | undefined)?.attempt_id;
  if (error.code === "FEEDBACK_REQUIRED" && owed && !pathname.startsWith("/results/")) reloadAt(`/results/${owed}`);
}

async function send<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(BASE + path, { method, headers, credentials: "same-origin", body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "TrainCheck could not be reached. Check your connection and try again.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const e = payload?.error;
    const error = new ApiError(response.status, e?.code ?? "INTERNAL_ERROR", e?.message ?? "Something went wrong. Please try again.", e?.details, e?.request_id);
    handleAccessCodes(error);
    throw error;
  }
  if (method !== "GET") for (const listener of mutationListeners) listener(path);
  return payload?.data as T;
}

export const api = {
  get: <T>(path: string) => send<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => send<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => send<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => send<T>("PATCH", path, body),
  del: <T>(path: string) => send<T>("DELETE", path),
  upload: <T>(path: string, form: FormData) => send<T>("POST", path, undefined, form),
};

/** Downloads through the authenticated API. The file URL itself grants nothing. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(BASE + path, { credentials: "same-origin" });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(response.status, payload?.error?.code ?? "INTERNAL_ERROR", payload?.error?.message ?? "This file could not be downloaded.");
  }
  const name = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toQuery(params: Record<string, string | undefined | null | boolean>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  const text = query.toString();
  return text ? `?${text}` : "";
}
