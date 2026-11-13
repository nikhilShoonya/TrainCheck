import type { PoolReport } from "./pool";

/* Shapes returned by the backend. Status values mirror backend/app/core/enums.py and must not diverge. */

export type RoleCode = "EMPLOYEE" | "LD_ADMIN";

export interface User {
  id: string;
  employee_id: string;
  employee_code: string;
  full_name: string;
  email: string;
  department: string | null;
  function: string | null;
  location: string | null;
  grade: string | null;
  roles: RoleCode[];
  primary_role: RoleCode;
  /** Switched-off workflows the interface should hide. The server enforces them regardless. */
  features?: { behaviour: boolean };
}

/** Why an assessment could not be scheduled or started, with what L&D should do next. */
export interface AssessmentReadiness {
  ready: boolean;
  reason: string | null;
  message: string;
  action: string | null;
}

export interface AffectedEmployee {
  employee_code: string;
  employee_name: string;
  completed_at?: string | null;
  due_at?: string | null;
}

export interface QueueItem {
  obligation_id: string;
  training_id: string;
  training_title: string;
  training_description: string | null;
  question_count: number;
  duration_seconds: number;
  pass_mark_percent: number;
  max_attempts: number;
  attempts_used: number;
  due_at: string | null;
  in_progress: boolean;
  refresher_required: boolean;
  queue_order: number;
}

export interface AccessState {
  access_status: "DASHBOARD_ALLOWED" | "ASSESSMENT_REQUIRED";
  pending_count: number;
  next_action: string;
  queue: QueueItem[];
}

export interface Summary {
  assignments: number;
  employees: number;
  completed: number;
  trained_employees: number;
  assessed: number;
  passed: number;
  not_passed: number;
  not_passed_employees: number;
  needs_retraining_employees: number;
  pending_assessment: number;
  in_progress: number;
  pass_rate: number | null;
  completion_rate: number | null;
  mean_latest_score: number | null;
}

export interface TrendPoint {
  month: string;
  completion_rate: number | null;
  pass_rate: number | null;
}

export interface BehaviourMeans {
  self_mean: number | null;
  manager_mean: number | null;
  self_count: number;
  manager_count: number;
}

export interface TrainingCard {
  enrolment_id: string;
  training_id: string;
  title: string;
  category: string | null;
  description: string | null;
  trainer: string | null;
  batch: string | null;
  assigned_at: string | null;
  completed_at: string | null;
  attendance_status: string;
  result: string;
  assessment_state: string;
  first_score: number | null;
  best_score: number | null;
  latest_score: number | null;
  attempts: number;
  latest_attempt_id: string | null;
  obligation_id: string | null;
  due_at: string | null;
  retake_pending: boolean;
  refresher_acknowledged: boolean;
  question_count: number | null;
  duration_minutes: number | null;
  pass_mark_percent: number | null;
  max_attempts: number | null;
  pre_test_available: boolean;
  pre_test_score: number | null;
  materials: { id: string; kind: string; title: string; url: string }[];
  refresher_text?: string | null;
  refresher_url?: string | null;
  attempt_history?: { attempt_id: string; number: number; score: number; result: string; submitted_at: string; reason: string }[];
}

export interface AttemptQuestionView {
  attempt_question_id: string;
  position: number;
  question_text: string;
  question_type: "MCQ_SINGLE" | "MCQ_MULTIPLE" | "TRUE_FALSE" | "SCENARIO";
  topic: string;
  language: string;
  marks: number;
  options: { option_id: string; label: string; text: string }[];
  selected_option_ids: string[];
  marked_for_review: boolean;
  saved_at: string | null;
}

export interface AttemptView {
  attempt_id: string;
  obligation_id: string;
  assessment_type: "PRE_TEST" | "POST_TEST";
  training_title: string;
  attempt_number: number;
  max_attempts: number;
  status: string;
  started_at: string;
  expires_at: string;
  server_now: string;
  remaining_seconds: number;
  violation_count: number;
  violation_limit: number;
  require_fullscreen: boolean;
  monitored: boolean;
  questions: AttemptQuestionView[];
}

export interface ResultView {
  attempt_id: string;
  obligation_id: string;
  assessment_type: "PRE_TEST" | "POST_TEST";
  training_title: string;
  attempt_status: string;
  attempt_number: number;
  max_attempts: number;
  attempts_remaining: number;
  score_percent: number;
  result_status: "PASSED" | "NOT_PASSED";
  pass_mark_percent: number;
  obtained_marks: number;
  total_marks: number;
  submitted_at: string;
  submission_reason: "MANUAL" | "TIME_EXPIRED" | "VIOLATION_LIMIT";
  time_taken_seconds: number;
  question_count: number;
  answered_count: number;
  correct_count: number;
  first_score: number | null;
  best_score: number | null;
  latest_score: number | null;
  topics: { name: string; score: number | null }[];
  explanations_enabled: boolean;
  answer_review: { position: number; question_text: string; your_answer: string[]; correct_answer: string[]; is_correct: boolean; explanation: string | null }[];
  needs_retraining: boolean;
  retake_pending: boolean;
  refresher: { text: string | null; url: string | null; acknowledged: boolean } | null;
  violations: { number: number; type: string; signals: string[]; occurred_at: string }[];
  interruptions: number;
  access_state?: AccessState;
}

export interface ReviewSummary {
  review_id: string;
  reviewer_type: "SELF" | "MANAGER";
  employee_id: string;
  employee_name: string;
  employee_code: string;
  training_id: string;
  training_title: string;
  period_days: number;
  due_at: string;
  status: "NOT_DUE" | "PENDING" | "SUBMITTED" | "OVERDUE" | "CANCELLED";
  submitted_at: string | null;
  submitted_by: string | null;
  template_name: string;
}

export interface ReviewForm extends ReviewSummary {
  questions: {
    template_question_id: string;
    competency: string;
    competency_description: string | null;
    prompt: string;
    example_required: boolean;
    rating: number | null;
    example_text: string | null;
    comment_text: string | null;
  }[];
  self_assessment?: ReviewForm["questions"] | null;
}

export interface TeamRow {
  enrolment_id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  department: string | null;
  location: string | null;
  grade: string | null;
  training_id: string;
  training_title: string;
  batch: string | null;
  completed_at: string | null;
  due_at: string | null;
  assessment_state: string;
  result: string;
  first_score: number | null;
  best_score: number | null;
  latest_score: number | null;
  attempts: number;
  last_submitted_at: string | null;
}

export interface ReportData {
  code: string;
  title: string;
  description: string;
  columns: string[];
  rows: (string | number)[][];
  definitions: string[];
  filters: Record<string, string>;
  generated_at: string;
}

export interface Scorecard {
  training: { id: string; code: string; title: string; category: string | null; trainer: string | null; owner: string | null; batches: string[]; followup_days: number[] };
  generated_at: string;
  learning: {
    state: string;
    assigned: number;
    completed: number;
    assessed: number;
    pre_test_state: string;
    pre_test_mean: number | null;
    post_test_mean: number | null;
    first_attempt_mean: number | null;
    best_score_mean: number | null;
    pass_rate: number | null;
    failed_attempts: number;
    needs_retraining: number;
    matched_pairs: number;
    learning_gain_mean: number | null;
    normalised_gain_mean: number | null;
    topics: { topic: string; score: number | null }[];
    questions: { question: string; topic: string; responses: number; correct: number; correct_percent: number | null }[];
  };
  behaviour: {
    state: string;
    self_mean: number | null;
    manager_mean: number | null;
    self_manager_gap: number | null;
    overdue: number;
    improvement_status: string;
    periods: { period_days: number; self_mean: number | null; manager_mean: number | null; self_submitted: number; manager_submitted: number; reviews_total: number; overdue: number; not_due: number }[];
    competencies: { competency: string; self_mean: number | null; manager_mean: number | null; gap: number | null }[];
  };
  interpretation: string;
}

export interface Named {
  id: string;
  name: string;
}

export interface OrgUnit {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

export interface ConfigView {
  id: string;
  assessment_type: string;
  version: number;
  question_count: number;
  duration_minutes: number;
  pass_mark_percent: number;
  max_attempts: number;
  schedule_mode: string;
  schedule_delay_days: number;
  schedule_uses_working_days: boolean;
  /** FIXED_DATE only: the day the assessment is held (YYYY-MM-DD). */
  schedule_date: string | null;
  difficulty_mix: Record<string, number> | null;
  show_explanations: boolean;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  violation_limit: number;
  require_fullscreen: boolean;
}

export interface TrainingAdmin {
  id: string;
  training_code: string;
  title: string;
  description: string | null;
  category: string | null;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  owner_name: string | null;
  owner_employee_id: string | null;
  trainer_name: string | null;
  trainer_id: string | null;
  target_scope: "COMMON" | "DEPARTMENT" | "FUNCTION" | "COMBINED";
  departments: Named[];
  functions: Named[];
  competencies: Named[];
  pretest_enabled: boolean;
  behaviour_enabled: boolean;
  followup_days: number[];
  item_minimum_sample: number;
  refresher_text: string | null;
  refresher_url: string | null;
  assigned_count: number;
  completed_count: number;
  config: ConfigView | null;
  materials?: { id: string; kind: string; title: string; url: string }[];
  pre_test_config?: ConfigView | null;
  pool_problem?: PoolReport | null;
  question_pool?: PoolReport;
  eligible_questions: number;
  config_ready: boolean;
  assessment_readiness: AssessmentReadiness;
  pending_scheduling_count: number;
  unavailable_count: number;
  pending_scheduling?: AffectedEmployee[];
  unavailable_assessments?: AffectedEmployee[];
}
