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

export async function runSystemCheck(requireFullscreen: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, label: string, status: Check["status"], detail: string, essential: boolean) => checks.push({ id, label, status, detail, essential });

  const missing = [
    ["Promises", typeof Promise === "function"],
    ["Fetch", typeof fetch === "function"],
    ["Secure random IDs", typeof crypto?.randomUUID === "function"],
  ]
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  add("browser", "Browser support", missing.length ? "fail" : "pass", missing.length ? `Missing: ${missing.join(", ")}. Update or change your browser.` : "Required browser features are available.", true);
  add("javascript", "JavaScript", "pass", "Enabled. This page is running its scripts.", true);

  const online = navigator.onLine !== false;
  add("internet", "Internet connection", online ? "pass" : "fail", online ? "The browser reports an active network connection." : "The browser reports that it is offline. Reconnect and retry.", true);

  let reachable = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch("/api/v1/system/ping", { cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    reachable = response.ok;
  } catch {
    reachable = false;
  }
  add("application", "Application connection", reachable ? "pass" : "fail", reachable ? "The TrainCheck server responded." : "TrainCheck could not be reached. Check your connection and retry.", true);

  const fullscreen = Boolean(document.fullscreenEnabled);
  add("fullscreen", "Full-screen support", fullscreen ? "pass" : requireFullscreen ? "fail" : "warn", fullscreen ? "Full-screen mode is available." : "This browser does not allow full-screen pages. Use a desktop browser such as Chrome, Edge or Firefox.", requireFullscreen);

  const width = window.innerWidth;
  const small = width < 768;
  add("screen", "Screen size", width < 320 ? "fail" : small ? "warn" : "pass", `Screen ${screen.width} × ${screen.height} · window ${width} × ${window.innerHeight}${width < 320 ? ". The window is too narrow." : small ? ". A larger screen is recommended." : ""}`, width < 320);

  const browser = browserName(navigator.userAgent);
  add("compatibility", "Browser compatibility", browser ? "pass" : "warn", browser ? `${browser.name} ${browser.version} detected.` : "Browser not recognised. You can continue if every required check is ready.", false);
  return checks;
}

export const systemCheckPassed = (checks: Check[] | null) => Boolean(checks?.length) && checks!.every((c) => !c.essential || c.status === "pass");
