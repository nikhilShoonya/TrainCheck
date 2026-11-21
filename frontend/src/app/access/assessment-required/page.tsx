import { GateFlow } from "@/features/exam/GateFlow";

export default async function Page({ searchParams }: { searchParams: Promise<{ fromCountdown?: string | string[] }> }) {
  const { fromCountdown } = await searchParams;
  return <GateFlow openPreparationFor={typeof fromCountdown === "string" ? fromCountdown : undefined} />;
}
