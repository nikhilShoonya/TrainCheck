"use client";

import { EllipsisVertical } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Btn } from "@/components/ui";

export function TrainingActionsMenu({ title, onDetails, onEdit, onDelete }: { title: string; onDetails: () => void; onEdit: () => void; onDelete: () => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const close = (restoreFocus = false) => {
    if (popup.current?.matches(":popover-open")) popup.current.hidePopover();
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  const show = (last = false) => {
    const menu = popup.current;
    const button = trigger.current;
    if (!menu || !button) return;
    menu.showPopover();
    // The native top layer avoids clipping inside the table's scrolling container.
    const anchor = button.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - box.width, width - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.bottom + box.height + 6 <= height - 8 ? anchor.bottom + 6 : anchor.top - box.height - 6, height - box.height - 8))}px`;
    const items = menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]");
    items[last ? items.length - 1 : 0]?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      if (popup.current?.matches(":popover-open")) popup.current.hidePopover();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-btn training-actions-trigger"
        aria-label={`More actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        onClick={(event) => {
          event.preventDefault();
          if (popup.current?.matches(":popover-open")) close();
          else show();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowUp");
          }
        }}
      >
        <EllipsisVertical aria-hidden="true" />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="menu"
        aria-label={`Actions for ${title}`}
        className="training-actions-menu"
        onToggle={(event) => setOpen(event.newState === "open")}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            close(true);
            return;
          }
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "ArrowDown" ? (current + 1) % items.length : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
          if (next !== null) {
            event.preventDefault();
            items[next]?.focus({ preventScroll: true });
          }
        }}
      >
        {[
          { label: "Details", select: onDetails },
          { label: "Edit", select: onEdit },
          { label: "Delete", select: onDelete },
        ].map((action) => (
          <Btn key={action.label} kind="text" tone={action.label === "Delete" ? "danger" : undefined} role="menuitem" tabIndex={-1} onClick={() => { close(true); action.select(); }}>
            {action.label}
          </Btn>
        ))}
      </div>
    </>
  );
}
