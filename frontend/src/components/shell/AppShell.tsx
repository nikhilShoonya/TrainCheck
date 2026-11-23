"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Btn, Empty, ErrorPanel, useToast } from "@/components/ui";
import { Modal } from "@/components/ui/dialog";
import { Art } from "@/components/shell/Art";
import { navFor, ROLE_LABEL, SIDEBAR_COPY } from "@/components/shell/nav";
import { useQueryClient } from "@tanstack/react-query";
import { useApi, useSession } from "@/lib/hooks";
import { NAV_PREFETCH, prefetchPaths } from "@/lib/query";
import type { RoleCode, User } from "@/lib/types";
import { initials } from "@/lib/utils";

/* Demo accounts' portraits, keyed by the synthetic demo employee codes. Only in demo mode: a real employee who happens
   to have one of these codes sees their initials, never a stock demo face. */
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const PORTRAITS: Record<string, string> = { E001: "employee", M001: "manager", A001: "admin", H001: "hr" };

/* At this width and below the sidebar is an off-canvas drawer (reference.css). While it is closed it is moved off
   screen, so it is made inert: its links must not be invisible keyboard stops (audit B20). */
const MOBILE_NAV = "(max-width: 900px)";
const subscribeMobileNav = (onChange: () => void) => {
  const query = window.matchMedia(MOBILE_NAV);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

export function Brand() {
  return (
    <div className="reference-brand asset-logo">
      <Art file="green-login" box="90 52 285 70" />
      <span className="sr-only">TrainCheck · Finvasia L&D Evaluation</span>
    </div>
  );
}

function Portrait({ user }: { user: User }) {
  const file = DEMO_MODE ? PORTRAITS[user.employee_code] : undefined;
  return file ? <Art file={file} box="1420 10 45 48" className="profile-portrait" /> : <>{initials(user.full_name)}</>;
}

function SearchDialog({ query, onClose, role }: { query: string; onClose: () => void; role: RoleCode }) {
  const results = useApi<{ type: string; title: string; subtitle: string | null; employee_id?: string }[]>(`/search?q=${encodeURIComponent(query)}`);
  const { user } = useSession();
  const pages = navFor(role, user?.features).filter(([, label]) => label.toLowerCase().includes(query.toLowerCase()));
  const router = useRouter();
  const go = (href: string) => {
    onClose();
    router.push(href);
  };
  const trainingsHref = role === "LD_ADMIN" ? "/lnd/trainings" : "/employee/trainings";
  // An employee result opens that person's assignments; only L&D Admins receive employee results.
  const hrefFor = (r: { type: string; subtitle: string | null; title: string }) => (r.type === "employee" ? `/lnd/assignments?search=${encodeURIComponent(r.subtitle ?? r.title)}` : trainingsHref);
  return (
    <Modal title="Search results" onClose={onClose}>
      <p>Results for “{query}” in your authorised workspace.</p>
      {pages.map(([href, label, icon]) => (
        <div className="search-result" key={href}>
          <Icon name={icon} />
          <span>{label}</span>
          <Btn kind="text" onClick={() => go(href)}>
            Open
          </Btn>
        </div>
      ))}
      {results.data?.map((r) => (
        <div className="search-result" key={`${r.type}-${r.title}`}>
          <Icon name={r.type === "employee" ? "users" : "book"} />
          <span>
            <strong>{r.title}</strong>
            <small>{r.subtitle}</small>
          </span>
          <Btn kind="text" onClick={() => go(hrefFor(r))}>
            View
          </Btn>
        </div>
      ))}
      {results.data === null && !results.error ? (
        <p className="small" role="status">
          Searching…
        </p>
      ) : null}
      {results.error ? <ErrorPanel error={results.error} retry={results.reload} /> : null}
      {results.data && !pages.length && !results.data.length ? <Empty title="No matching records." hint="Try another word." /> : null}
    </Modal>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useSession();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const mobileNav = useSyncExternalStore(subscribeMobileNav, () => window.matchMedia(MOBILE_NAV).matches, () => false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  /** Closes the drawer and returns focus to the button that opened it (Escape, the backdrop). */
  const closeNav = useCallback(() => {
    setNavOpen(false);
    menuButton.current?.focus();
  }, []);
  // Opening the drawer moves focus into it; Escape closes it and returns focus to the menu button.
  useEffect(() => {
    if (!navOpen || !mobileNav) return;
    sidebar.current?.querySelector<HTMLElement>("a.nav-link")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNav();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen, mobileNav, closeNav]);
  const toast = useToast();
  const [online, setOnline] = useState(true);
  const [search, setSearch] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // From the shared cache: not refetched on every navigation, refreshed after changes such as mark-as-read.
  // The exact count from the server (a limited list of unread items would stop counting at its limit).
  const unread = useApi<{ unread: number }>(user ? "/me/notifications/unread-count" : null).data?.unread ?? 0;
  const queryClient = useQueryClient();
  /** Navigation intent: load the page's first data while the pointer or keyboard focus is on its link. */
  const prefetchFor = (href: string) => {
    if (user && NAV_PREFETCH[href]) void prefetchPaths(queryClient, user.id, NAV_PREFETCH[href]);
  };
  const main = useRef<HTMLElement>(null);
  const profileMenu = useRef<HTMLDetailsElement>(null);

  // A navigation closes the mobile drawer and the account menu, and moves focus to the new page's heading.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNavOpen(false);
    if (profileMenu.current) profileMenu.current.open = false;
    window.scrollTo(0, 0);
    main.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [pathname]);

  // The account menu is a <details>, which stays open by itself: close it on a click outside or Escape.
  useEffect(() => {
    const close = (event: Event) => {
      const menu = profileMenu.current;
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        menu.open = false;
        menu.querySelector("summary")?.focus();
      } else if (!menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    const onConnection = () => setOnline(navigator.onLine);
    // Following a link while offline makes the browser replace the whole app with its own offline page.
    // Stay on the current page instead and say why.
    const onClick = (event: MouseEvent) => {
      if (navigator.onLine || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.origin !== window.location.origin || link.target === "_blank") return;
      event.preventDefault();
      toast("You are offline. Reconnect to open another page.");
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("online", onConnection);
    window.addEventListener("offline", onConnection);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("online", onConnection);
      window.removeEventListener("offline", onConnection);
      document.removeEventListener("click", onClick, true);
    };
  }, [toast]);

  if (!user) return null;
  const role = user.primary_role;
  const items = navFor(role, user.features);
  const [praiseTitle, praiseLines] = SIDEBAR_COPY[role];
  const activeHref = [...items].sort((a, b) => b[0].length - a[0].length).find(([href]) => pathname === href || pathname.startsWith(`${href}/`))?.[0];

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get("query")?.toString().trim();
    if (query) setSearch(query);
  };

  return (
    <div className={`workspace reference-workspace${collapsed ? " is-collapsed" : ""}${navOpen ? " nav-open" : ""}`} data-role={role}>
      <aside className="sidebar" id="sidebar" ref={sidebar} aria-label={`${ROLE_LABEL[role]} workspace`} inert={mobileNav && !navOpen}>
        <Brand />
        <nav aria-label="Main navigation">
          {items.map(([href, text, icon]) => (
            <Link key={href} href={href} className={`nav-link${href === activeHref ? " active" : ""}`} aria-label={text} title={text} aria-current={href === activeHref ? "page" : undefined} onMouseEnter={() => prefetchFor(href)} onFocus={() => prefetchFor(href)}>
              <Icon name={icon} />
              <span>{text}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-encouragement">
          <div className="trophy-orbit">
            <Icon name="trophy" />
            <i>✦</i>
            <i>✧</i>
          </div>
          <strong>{praiseTitle}</strong>
          <p>
            {praiseLines.map((line, i) => (
              <span key={line}>
                {i ? <br /> : null}
                {line}
              </span>
            ))}
          </p>
          <span className="side-wave" />
        </div>
        <div className="sidebar-tools">
          {/* The text is hidden while collapsed, so the label keeps the button named for screen readers. */}
          <Btn kind="text" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-controls="sidebar" title={collapsed ? "Expand sidebar" : undefined} onClick={() => setCollapsed((c) => !c)}>
            <Icon name={collapsed ? "chevron" : "menu"} />
            <span>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
          </Btn>
        </div>
      </aside>
      {navOpen ? <button className="nav-backdrop" aria-label="Close navigation" onClick={closeNav} /> : null}
      <div className="workspace-main">
        <header className="topbar">
          <button ref={menuButton} className="icon-btn mobile-menu" aria-label="Open navigation" aria-expanded={navOpen} aria-controls="sidebar" onClick={() => setNavOpen((o) => !o)}>
            <Icon name="menu" />
          </button>
          <span className="finvasia-wordmark" aria-label="Finvasia">
            <Art file="green-login" box="462 52 196 52" className="finvasia-logo-crop" />
          </span>
          <form className="global-search" id="global-search" role="search" onSubmit={submitSearch}>
            <Icon name="search" />
            <label className="sr-only" htmlFor="global-query">
              Search trainings, reports or help
            </label>
            <input ref={searchInput} id="global-query" name="query" placeholder="Search trainings, reports, or help…" autoComplete="off" required />
            <button type="button" aria-label="Focus search" onClick={() => searchInput.current?.focus()}>
              <kbd>⌘ K</kbd>
            </button>
          </form>
          <div className="top-actions">
            <Link href="/notifications" className="notification-button icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
              <Icon name="bell" />
              {unread ? <span className="notification-dot" /> : null}
            </Link>
            <details className="profile-menu" ref={profileMenu}>
              <summary>
                <span className="avatar reference-avatar">
                  <Portrait user={user} />
                </span>
                <span className="profile-copy">
                  <strong>{user.full_name}</strong>
                  <small>{ROLE_LABEL[role]}</small>
                </span>
                <Icon name="down" />
              </summary>
              <div className="profile-dropdown">
                <Link href="/profile" className="btn text">
                  My profile
                </Link>
                {role !== "EMPLOYEE" ? (
                  <Link href="/employee" className="btn text">
                    My own training
                  </Link>
                ) : null}
                <Btn kind="text" tone="danger" onClick={() => void signOut()}>
                  Sign out
                </Btn>
              </div>
            </details>
          </div>
        </header>
        <div id="connection" className="connection" hidden={online}>
          You are offline. Reconnect to load or save your work.
        </div>
        <main id="main" className="content" ref={main}>
          {pathname !== items[0][0] ? <BackButton /> : null}
          {children}
        </main>
        <footer>
          <span>TrainCheck · Finvasia L&D Evaluation</span>
          <span>{user.features?.behaviour ? "Learning and behaviour evidence" : "Learning evidence"}</span>
        </footer>
      </div>
      {search !== null ? <SearchDialog query={search} role={role} onClose={() => setSearch(null)} /> : null}
    </div>
  );
}

function BackButton() {
  const router = useRouter();
  return (
    <button className="btn secondary page-back" aria-label="Go back to the previous page" title="Back" onClick={() => router.back()}>
      <Icon name="back" />
    </button>
  );
}

export function FocusShell({ children, footer = "Your answers and timer are managed securely by TrainCheck." }: { children: ReactNode; footer?: string }) {
  const { signOut } = useSession();
  return (
    <div className="assessment-layout">
      <header className="focus-header">
        <div className="focus-logo">
          <Art file="green-login" box="90 52 285 70" />
          <span className="sr-only">TrainCheck · Finvasia L&D Evaluation</span>
        </div>
        <span className="muted">Learning verification</span>
        <Btn kind="text" tone="danger" onClick={() => void signOut()}>
          Sign out
        </Btn>
      </header>
      <main id="main" className="assessment-main">
        {children}
      </main>
      <div className="focus-footer">{footer}</div>
    </div>
  );
}
