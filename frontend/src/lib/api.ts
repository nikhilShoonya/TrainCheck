/* The one API client. The browser never decides access: it follows the codes the backend returns.

   Every request is bounded: it fails with TIMEOUT if the reply (headers and body) has not fully arrived in time,
   and it can be cancelled with an AbortSignal (ABORTED). A successful reply must be the API envelope
   ({"data": ...}); anything else (an HTML page, an empty or malformed body) is INVALID_RESPONSE, never success.

   No parameter properties and no path aliases here: the unit tests load this file directly with Node. */

import { parseRetryAfter } from "./retryAfter";

const BASE = "/api/v1";
/** The longest any request may take unless the caller says otherwise. Uploads have no default limit. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  /** Seconds the server asked us to wait (Retry-After), when it said. */
  retryAfterSeconds: number | null = null;
  status: number;
  code: string;
  details?: unknown;
  requestId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export interface RequestOptions {
  /** Cancels the request (and the wait for its body). */
  signal?: AbortSignal;
  /** Overrides the default limit, in milliseconds. */
  timeoutMs?: number;
}

const networkError = () => new ApiError(0, "NETWORK_ERROR", "TrainCheck could not be reached. Check your connection and try again.");
const timeoutError = () => new ApiError(0, "TIMEOUT", "TrainCheck did not reply in time. Check your connection and try again.");
const abortedError = () => new ApiError(0, "ABORTED", "The request was cancelled.");
export const invalidResponse = (status: number) => new ApiError(status, "INVALID_RESPONSE", "TrainCheck sent a reply this page could not read, so nothing was confirmed. Please try again.");

function csrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|; )tc_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

const isEnvelope = (payload: unknown): payload is { data: unknown } => typeof payload === "object" && payload !== null && !Array.isArray(payload) && Object.hasOwn(payload, "data");

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

async function send<T>(method: string, path: string, body?: unknown, form?: FormData, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const limit = options.timeoutMs ?? (form ? null : DEFAULT_TIMEOUT_MS);

  // One controller cancels the fetch and its body; `stopped` settles the waits even if the runtime does not.
  const controller = new AbortController();
  let fail: (error: ApiError) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => (fail = reject));
  stopped.catch(() => undefined); // Observed through Promise.race below; never an unhandled rejection.
  let reason: ApiError | null = null;
  const stop = (error: ApiError) => {
    if (reason) return;
    reason = error;
    controller.abort();
    fail(error);
  };
  const onAbort = () => stop(abortedError());
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = limit !== null ? setTimeout(() => stop(timeoutError()), limit) : null;

  try {
    let response: Response;
    try {
      const request = fetch(BASE + path, { method, headers, credentials: "same-origin", signal: controller.signal, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
      response = await Promise.race([request, stopped]);
    } catch (error) {
      throw reason ?? (error instanceof ApiError ? error : networkError());
    }
    let text: string;
    try {
      text = await Promise.race([response.text(), stopped]); // A body that stalls is bounded too.
    } catch (error) {
      throw reason ?? (error instanceof ApiError ? error : networkError());
    }
    let payload: unknown = null;
    try {
      payload = text.trim() ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const e = (payload as { error?: { code?: string; message?: string; details?: unknown; request_id?: string } } | null)?.error;
      const error = new ApiError(response.status, e?.code ?? "INTERNAL_ERROR", e?.message ?? "Something went wrong. Please try again.", e?.details, e?.request_id);
      error.retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"), Date.now());
      handleAccessCodes(error);
      throw error;
    }
    if (!isEnvelope(payload)) throw invalidResponse(response.status); // HTML, empty or malformed: not a success.
    if (method !== "GET") for (const listener of mutationListeners) listener(path);
    return payload.data as T;
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => send<T>("GET", path, undefined, undefined, options),
  post: <T>(path: string, body: unknown = {}, options?: RequestOptions) => send<T>("POST", path, body, undefined, options),
  put: <T>(path: string, body: unknown, options?: RequestOptions) => send<T>("PUT", path, body, undefined, options),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) => send<T>("PATCH", path, body, undefined, options),
  del: <T>(path: string, options?: RequestOptions) => send<T>("DELETE", path, undefined, undefined, options),
  upload: <T>(path: string, form: FormData, options?: RequestOptions) => send<T>("POST", path, undefined, form, options),
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
