import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui";
import { SessionProvider } from "@/lib/hooks";
import "@/styles/tailwind.css";
import "@/styles/prototype/styles.css";
import "@/styles/prototype/reference.css";
import "@/styles/prototype/role-dashboards.css";
import "@/styles/prototype/green-theme.css";
import "@/styles/prototype/layout-fixes.css";
import "@/styles/prototype/certificate.css";
import "@/styles/prototype/button-tones.css";
import "@/styles/prototype/secure-exam.css";
import "@/styles/traincheck.css";

export const metadata: Metadata = {
  title: "TrainCheck · Learn. Apply. Verify.",
  description: "Finvasia training evaluation: did the employee learn, and are they applying it at work?",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SessionProvider>
          <ToastProvider>{children}</ToastProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
