/* Browser-level, best-effort monitoring. A web page cannot detect or prevent a second device, screenshots,
   extensions or developer tools. The browser only reports signals; the server counts violations. */

export type ViolationType = "TAB_HIDDEN" | "FOCUS_LOST" | "FULLSCREEN_EXIT" | "NAVIGATION";

export const VIOLATION_LABELS: Record<string, string> = {
  TAB_HIDDEN: "Switched to another tab or minimised the window",
  FOCUS_LOST: "Moved focus away from the assessment window",
  FULLSCREEN_EXIT: "Exited full-screen mode",
  NAVIGATION: "Tried to navigate away from the assessment",
};

const DEDUPE_MS = 2000;
const LEAVE_PROMPT_GRACE_MS = 1500;

export const isFullscreen = () => Boolean(document.fullscreenElement);

export async function enterFullscreen(): Promise<string | null> {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch (error) {
    const name = (error as Error).name;
    return name === "NotAllowedError" || name === "TypeError" ? "The browser blocked full screen. Allow full screen for this site, then try again." : "Full screen is not available in this browser.";
  }
  return isFullscreen() ? null : "Full screen did not turn on. Allow full screen for this site, then try again.";
}

export function exitFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}

/** Merges the several browser events one action causes, so one tab switch reaches the server once.
 *  A refresh is a recovery path, not a violation: the leave prompt's side effects are ignored. */
export function startMonitor(onSignal: (type: ViolationType) => void, onFullscreenChange: () => void): () => void {
  let lastSignalAt = 0;
  let incidentOpen = false;
  let returnedAt: number | null = null;
  let graceUntil = 0;
  let unloading = false;

  const signal = (type: ViolationType) => {
    if (unloading) return;
    const now = Date.now();
    if (now < graceUntil && type !== "TAB_HIDDEN") return;
    const sameIncident = now - lastSignalAt < DEDUPE_MS || (incidentOpen && (returnedAt === null || now - returnedAt < DEDUPE_MS));
    lastSignalAt = now;
    if (sameIncident) return;
    incidentOpen = type === "TAB_HIDDEN" || type === "FOCUS_LOST";
    returnedAt = null;
    onSignal(type);
  };
  const settle = () => {
    if (incidentOpen && returnedAt === null && !document.hidden && document.hasFocus()) returnedAt = Date.now();
  };

  const onVisibility = () => (document.hidden ? signal("TAB_HIDDEN") : settle());
  const onFullscreen = () => {
    if (!isFullscreen()) signal("FULLSCREEN_EXIT");
    else settle();
    onFullscreenChange();
  };
  const onBlur = () => signal("FOCUS_LOST");
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    graceUntil = Date.now() + LEAVE_PROMPT_GRACE_MS;
    event.preventDefault();
  };
  const onPageHide = () => {
    unloading = true;
  };
  const onPageShow = () => {
    unloading = false;
    graceUntil = 0;
  };
  const onPopState = () => {
    history.pushState({ exam: true }, "", location.href);
    signal("NAVIGATION");
  };
  const block = (event: Event) => {
    if (event.type === "selectstart" && (event.target as Element)?.closest?.("textarea,input")) return;
    event.preventDefault();
  };
  const deterrents = ["copy", "cut", "paste", "contextmenu", "selectstart", "dragstart"];

  history.pushState({ exam: true }, "", location.href);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("fullscreenchange", onFullscreen);
  deterrents.forEach((name) => document.addEventListener(name, block));
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", settle);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("popstate", onPopState);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("fullscreenchange", onFullscreen);
    deterrents.forEach((name) => document.removeEventListener(name, block));
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", settle);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("popstate", onPopState);
  };
}

/* ---------- System check ---------- */

export interface Check {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "info";
  detail: string;
  essential: boolean;
}

function browserName(ua: string): { name: string; version: number } | null {
  const known: [string, RegExp][] = [
    ["Edge", /Edg\/(\d+)/],
    ["Opera", /OPR\/(\d+)/],
    ["Chrome", /Chrome\/(\d+)/],
    ["Firefox", /Firefox\/(\d+)/],
    ["Safari", /Version\/(\d+)[\d.]* .*Safari/],
  ];
  for (const [name, re] of known) {
    const match = ua.match(re);
    if (match) return { name, version: Number(match[1]) };
  }
  return null;
}

/** Number of rows the system check produces, so the page can show placeholders for the ones still running. */
export const SYSTEM_CHECK_COUNT = 7;

/** Smallest window an assessment may run in (tablet portrait and up). Smaller windows, such as phones, are blocked. */
const MIN_WINDOW_WIDTH = 768;
const MIN_WINDOW_HEIGHT = 500;
/** Oldest versions with every browser feature the exam relies on. Older or unrecognised browsers are blocked. */
const MIN_VERSIONS: Record<string, number> = { Chrome: 100, Edge: 100, Firefox: 100, Opera: 86, Safari: 15 };
const PING_COUNT = 3;
const SLOW_MS = 2000;

/** One real request with a time limit. Returns the response (null when nothing came back) and how long it took. */
async function timedRequest(path: string, timeoutMs = 8000): Promise<{ response: Response | null; ms: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(path, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
    return { response, ms: Math.round(performance.now() - started) };
  } catch {
    return { response: null, ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

/** Every check is measured on this device at the moment it runs; nothing is assumed. `onProgress` receives the
 *  rows finished so far, so the page fills in as each test completes. */
export async function runSystemCheck(requireFullscreen: boolean, onProgress?: (checks: Check[]) => void): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, label: string, status: Check["status"], detail: string, essential: boolean) => {
    checks.push({ id, label, status, detail, essential });
    onProgress?.([...checks]);
  };

  // 1. Browser support: each feature the exam uses is exercised, not only looked up.
  const features: [string, () => boolean][] = [
    ["Network requests", () => typeof fetch === "function" && typeof new AbortController().abort === "function"],
    ["Secure random IDs", () => /^[0-9a-f-]{36}$/.test(crypto.randomUUID())],
    ["Tab-switch detection", () => typeof document.visibilityState === "string" && typeof document.hidden === "boolean"],
    ["Focus detection", () => typeof document.hasFocus() === "boolean"],
    ["Navigation lock", () => typeof history.pushState === "function" && typeof history.state !== "undefined"],
    ["Precise timing", () => typeof performance.now() === "number"],
  ];
  const missing = features
    .filter(([, works]) => {
      try {
        return !works();
      } catch {
        return true;
      }
    })
    .map(([name]) => name);
  add("browser", "Browser support", missing.length ? "fail" : "pass", missing.length ? `Not working in this browser: ${missing.join(", ")}. Update or change your browser.` : `All ${features.length} browser features the assessment uses work here.`, true);

  // 2. Signed-in session: answers are saved to the signed-in account, so the server must accept this session.
  const me = await timedRequest("/api/v1/auth/me");
  if (me.response?.ok) {
    const body = (await me.response.json().catch(() => null)) as { data?: { user?: { full_name?: string } } } | null;
    const name = body?.data?.user?.full_name;
    add("session", "Signed-in session", "pass", name ? `Signed in as ${name}. Your answers will be saved to this account.` : "Your sign-in is active. Your answers will be saved to your account.", true);
  } else if (me.response?.status === 401) {
    add("session", "Signed-in session", "fail", "Your sign-in has expired. Sign out, sign in again, then retry.", true);
  } else {
    add("session", "Signed-in session", "fail", me.response ? `TrainCheck could not confirm your sign-in (status ${me.response.status}). Retry.` : "TrainCheck could not confirm your sign-in. Check your connection and retry.", true);
  }

  // 3 and 4. Internet and application: several real round trips to the TrainCheck server, timed.
  const times: number[] = []; // Round trips that came back, whatever the reply.
  let correct = 0; // Replies that were the server's expected answer.
  let badStatus: number | null = null;
  for (let i = 0; i < PING_COUNT; i++) {
    const { response, ms } = await timedRequest("/api/v1/system/ping");
    if (!response) continue;
    times.push(ms);
    const body = (await response.json().catch(() => null)) as { data?: { ok?: boolean; server_now?: string } } | null;
    if (response.ok && body?.data?.ok === true && body.data.server_now) correct++;
    else badStatus = response.status;
  }
  const lost = PING_COUNT - times.length;
  const average = times.length ? Math.round(times.reduce((sum, t) => sum + t, 0) / times.length) : 0;
  if (navigator.onLine === false) {
    add("internet", "Internet connection", "fail", "This device is offline. Reconnect and retry.", true);
  } else if (lost === PING_COUNT) {
    add("internet", "Internet connection", "fail", `None of ${PING_COUNT} test requests got through. Check your connection and retry.`, true);
  } else if (lost) {
    add("internet", "Internet connection", "fail", `${lost} of ${PING_COUNT} test requests ${lost === 1 ? "was" : "were"} lost. The connection is unstable, so answers may not save. Retry on a steadier connection.`, true);
  } else {
    add("internet", "Internet connection", "pass", `${PING_COUNT} of ${PING_COUNT} test requests got through · average ${average} ms${average > SLOW_MS ? ". The connection is slow, so answers may take a moment to save." : "."}`, true);
  }
  if (correct === PING_COUNT) {
    add("application", "Application connection", "pass", `The TrainCheck server answered all ${PING_COUNT} requests correctly.`, true);
  } else if (badStatus !== null) {
    add("application", "Application connection", "fail", `The TrainCheck server sent an unexpected reply (status ${badStatus}). Retry in a moment.`, true);
  } else {
    add("application", "Application connection", "fail", correct ? `The TrainCheck server answered only ${correct} of ${PING_COUNT} requests. Retry.` : "TrainCheck could not be reached. Check your connection and retry.", true);
  }

  // 5. Full screen: the browser must offer it, allow it for this page, and the page must not be inside another page.
  let framed = false;
  try {
    framed = window.self !== window.top;
  } catch {
    framed = true;
  }
  const hasApi = typeof document.documentElement.requestFullscreen === "function";
  const allowed = hasApi && Boolean(document.fullscreenEnabled) && !framed;
  const fullscreenProblem = framed ? "TrainCheck is open inside another page, which blocks full screen. Open it in its own browser tab." : !hasApi ? "This browser cannot show pages in full screen. Use Chrome, Edge or Firefox on a computer." : "Full screen is turned off for this page by a browser or organisation setting. Allow it, then retry.";
  add("fullscreen", "Full-screen support", allowed ? "pass" : requireFullscreen ? "fail" : "warn", allowed ? "This browser allows full screen here. It is switched on, and confirmed, in the next step." : fullscreenProblem, requireFullscreen);

  // 6. Screen size (required): the real window, measured now. Tablets, laptops and desktops pass; phones do not.
  const width = window.innerWidth;
  const height = window.innerHeight;
  const tooSmall = width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT;
  const sizeDetail = `Screen ${screen.width} × ${screen.height} · window ${width} × ${height}`;
  add("screen", "Screen size", tooSmall ? "fail" : "pass", tooSmall ? `${sizeDetail}. The assessment needs a window at least ${MIN_WINDOW_WIDTH} × ${MIN_WINDOW_HEIGHT}. Use a tablet, laptop or desktop, or make the window larger, then retry.` : `${sizeDetail} · meets the ${MIN_WINDOW_WIDTH} × ${MIN_WINDOW_HEIGHT} minimum.`, true);

  // 7. Browser version (required): a recognised browser at or above its oldest supported release.
  const browser = browserName(navigator.userAgent);
  const minimum = browser ? MIN_VERSIONS[browser.name] : undefined;
  const supported = Boolean(browser && minimum !== undefined && browser.version >= minimum);
  const versionDetail = !browser ? "Browser not recognised. Use a current version of Chrome, Edge, Firefox or Safari, then retry." : !supported ? `${browser.name} ${browser.version} is older than the supported ${browser.name} ${minimum}. Update the browser, then retry.` : `${browser.name} ${browser.version} · supported (${browser.name} ${minimum} or newer).`;
  add("compatibility", "Browser compatibility", supported ? "pass" : "fail", versionDetail, true);
  return checks;
}

export const systemCheckPassed = (checks: Check[] | null) => Boolean(checks?.length) && checks!.every((c) => !c.essential || c.status === "pass");
