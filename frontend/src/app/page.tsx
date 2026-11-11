"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { HOME } from "@/components/shell/nav";
import { Loading } from "@/components/ui";
import { useSession } from "@/lib/hooks";

export default function Home() {
  const { user, access, ready } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace("/login");
    else router.replace(access?.access_status === "ASSESSMENT_REQUIRED" ? "/access/assessment-required" : HOME[user.primary_role]);
  }, [ready, user, access, router]);
  return <Loading label="Opening TrainCheck…" />;
}
