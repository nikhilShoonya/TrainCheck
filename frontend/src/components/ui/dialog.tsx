"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

/* shadcn/ui's Dialog pattern on Radix. Radix provides the focus trap, Escape and aria wiring.
   Styling comes from the prototype's dialog classes so the appearance does not change. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="tc-dialog-overlay" />
        <DialogPrimitive.Content className={`tc-dialog${wide ? " tc-dialog-wide" : ""}`} aria-describedby={undefined}>
          <div className="dialog-header">
            <DialogPrimitive.Title asChild>
              <h2>{title}</h2>
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="icon-btn" aria-label="Close dialog">
              ✕
            </DialogPrimitive.Close>
          </div>
          <div className="dialog-body">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
