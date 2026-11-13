"""Canonical domain values (DATABASE_API_DESIGN.md §5). The frontend must not invent others."""
from enum import StrEnum


class RoleCode(StrEnum):
    EMPLOYEE = "EMPLOYEE"
    LD_ADMIN = "LD_ADMIN"


class EmploymentStatus(StrEnum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    ON_LEAVE = "ON_LEAVE"


class AccountStatus(StrEnum):
    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"


class TrainingStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    ARCHIVED = "ARCHIVED"


class TargetScope(StrEnum):
    COMMON = "COMMON"
    DEPARTMENT = "DEPARTMENT"
    FUNCTION = "FUNCTION"
    COMBINED = "COMBINED"


class EnrolmentStatus(StrEnum):
    ASSIGNED = "ASSIGNED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class AttendanceStatus(StrEnum):
    PENDING = "PENDING"
    PRESENT = "PRESENT"
    PARTIAL = "PARTIAL"
    ABSENT = "ABSENT"
    EXCUSED = "EXCUSED"


class MaterialKind(StrEnum):
    DOCUMENT = "DOCUMENT"
    LINK = "LINK"
    RECORDING = "RECORDING"


class QuestionType(StrEnum):
    MCQ_SINGLE = "MCQ_SINGLE"
    MCQ_MULTIPLE = "MCQ_MULTIPLE"
    TRUE_FALSE = "TRUE_FALSE"
    SCENARIO = "SCENARIO"


class Difficulty(StrEnum):
    EASY = "EASY"
    MEDIUM = "MEDIUM"
    HARD = "HARD"


class QuestionStatus(StrEnum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"


class AssessmentType(StrEnum):
    PRE_TEST = "PRE_TEST"
    POST_TEST = "POST_TEST"


class ScheduleMode(StrEnum):
    SAME_DAY = "SAME_DAY"
    NEXT_WORKING_DAY = "NEXT_WORKING_DAY"
    DELAY_DAYS = "DELAY_DAYS"
    FIXED_DATE = "FIXED_DATE"  # On a chosen calendar date; at once if completion is recorded on or after it.


class ObligationStatus(StrEnum):
    SCHEDULED = "SCHEDULED"
    DUE = "DUE"
    IN_PROGRESS = "IN_PROGRESS"
    RETAKE_PENDING = "RETAKE_PENDING"
    COMPLETED = "COMPLETED"
    WAIVED = "WAIVED"
    CANCELLED = "CANCELLED"


class AttemptStatus(StrEnum):
    IN_PROGRESS = "IN_PROGRESS"
    SUBMITTED = "SUBMITTED"
    TIMED_OUT = "TIMED_OUT"
    CANCELLED = "CANCELLED"


class ResultStatus(StrEnum):
    PASSED = "PASSED"
    NOT_PASSED = "NOT_PASSED"


class RetrainingFlag(StrEnum):
    NOT_REQUIRED = "NOT_REQUIRED"
    NEEDS_RETRAINING = "NEEDS_RETRAINING"
    RESOLVED = "RESOLVED"


class SubmissionReason(StrEnum):
    MANUAL = "MANUAL"
    TIME_EXPIRED = "TIME_EXPIRED"
    VIOLATION_LIMIT = "VIOLATION_LIMIT"


class SecurityEventType(StrEnum):
    TAB_HIDDEN = "TAB_HIDDEN"
    FOCUS_LOST = "FOCUS_LOST"
    FULLSCREEN_EXIT = "FULLSCREEN_EXIT"
    NAVIGATION = "NAVIGATION"
    NETWORK_INTERRUPTION = "NETWORK_INTERRUPTION"  # Recorded only; never counted as a violation.


VIOLATION_EVENT_TYPES = {
    SecurityEventType.TAB_HIDDEN,
    SecurityEventType.FOCUS_LOST,
    SecurityEventType.FULLSCREEN_EXIT,
    SecurityEventType.NAVIGATION,
}


class ReviewerType(StrEnum):
    SELF = "SELF"
    MANAGER = "MANAGER"


class ReviewStatus(StrEnum):
    NOT_DUE = "NOT_DUE"
    PENDING = "PENDING"
    SUBMITTED = "SUBMITTED"
    OVERDUE = "OVERDUE"
    CANCELLED = "CANCELLED"


class DataState(StrEnum):
    """Scorecard evidence states (SC-2L-101)."""

    AVAILABLE = "Available"
    NOT_YET_DUE = "Not yet due"
    NOT_CONFIGURED = "Not configured"
    NOT_COLLECTED = "Not collected"
    INCOMPLETE = "Incomplete"


class ImportType(StrEnum):
    QUESTIONS = "QUESTIONS"
    COMPLETIONS = "COMPLETIONS"


class ImportStatus(StrEnum):
    READY = "READY"
    COMPLETED = "COMPLETED"
    COMPLETED_WITH_ERRORS = "COMPLETED_WITH_ERRORS"
    CANCELLED = "CANCELLED"
    FAILED = "FAILED"


class ExportFormat(StrEnum):
    CSV = "CSV"
    XLSX = "XLSX"
    PDF = "PDF"


class ExportStatus(StrEnum):
    READY = "READY"
    FAILED = "FAILED"


class Cadence(StrEnum):
    WEEKLY = "WEEKLY"
    MONTHLY = "MONTHLY"


class DeliveryStatus(StrEnum):
    DELIVERED = "DELIVERED"
    FAILED = "FAILED"


class ReportCode(StrEnum):
    COMPLIANCE = "compliance"
    PASS_FAIL = "pass-fail"
    LEARNING_GAIN = "learning-gain"
    BEHAVIOUR = "behaviour"
    QUESTION_ANALYTICS = "question-analytics"
    EMPLOYEE_HISTORY = "employee-history"
    SCORECARD = "scorecard"
