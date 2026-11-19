import { AssessmentWaiting } from "@/features/exam/AssessmentWaiting";

export default async function Page({ params }: { params: Promise<{ obligationId: string }> }) {
  const { obligationId } = await params;
  return <AssessmentWaiting obligationId={obligationId} />;
}
