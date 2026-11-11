import { PreTestFlow } from "@/features/exam/GateFlow";

export default async function Page({ params }: { params: Promise<{ enrolmentId: string }> }) {
  const { enrolmentId } = await params;
  return <PreTestFlow enrolmentId={enrolmentId} />;
}
