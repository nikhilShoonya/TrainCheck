import type { FeedbackKey } from "./types";

/** Labels shared by historical and official training feedback in employee scorecards. */
export const FEEDBACK_LABELS: Record<FeedbackKey, string> = {
  satisfaction: "Overall satisfaction", role_relevance: "Role relevance", objectives: "Learning objectives",
  applicability: "Practical applicability", interaction: "Interaction", pace: "Pace and structure",
  trainer_preparation: "Trainer preparation", trainer_organisation: "Trainer preparation (previous duplicate)",
  materials: "Materials and resources", environment: "Learning environment", logistics: "Technical and logistical support",
  relevance: "Relevance", clarity: "Clarity", alignment: "Assessment match", fairness: "Fairness", confidence: "Confidence",
};
