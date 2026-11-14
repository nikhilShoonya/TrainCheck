"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { landingPath } from "@/components/shell/nav";
import { Loading } from "@/components/ui";
import { useSession } from "@/lib/hooks";

export default function Home() {
  const { user, access, ready } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace("/login");
    else router.replace(landingPath(user, access));
  }, [ready, user, access, router]);
  return <Loading label="Opening TrainCheck…" />;
}
