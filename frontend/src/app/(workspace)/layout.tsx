import type { ReactNode } from "react";
import { WorkspaceGuard } from "@/components/shell/WorkspaceGuard";

export default function Layout({ children }: { children: ReactNode }) {
  return <WorkspaceGuard>{children}</WorkspaceGuard>;
}
