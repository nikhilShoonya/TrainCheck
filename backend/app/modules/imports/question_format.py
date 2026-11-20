"""The department-facing MCQ import format, shared by CSV, XLSX and PDF files.

Departments supply only the question, four options, the correct letter and a topic. TrainCheck decides the rest:
- the training is the one selected in the Import Centre (linked by its ID), for the selected Pre-test or Post-test;
- the question ID is generated when L&D Admin confirms the import;
- every imported question is Single choice: four distinct options and exactly one correct letter, A to D;
- marks are 1 and difficulty is Easy (DEFAULT_MARKS, DEFAULT_DIFFICULTY). L&D changes them in the Question Bank;
- there is no competency, explanation, department or function: those stay empty (all optional on questions) and
  L&D can set them in the Question Bank. No competency is invented or created by an import;
- the level is L2 (every assessment question is; nothing is stored);
- the language is the existing internal default, English. The text is stored exactly as supplied, never translated;
- the status is Active once L&D Admin confirms, so the question can be drawn by the selected test straight away.

Without a question ID, repeated uploads are recognised by their content: see content_key() and Pool.
"""
import secrets
import unicodedata
import uuid
from decimal import Decimal

from sqlalchemy import exists, select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import Difficulty, QuestionType
from app.models import Question, QuestionAnswerKey, QuestionTrainingTag

FIELDS = ["question", "option_a", "option_b", "option_c", "option_d", "correct", "topic"]
REQUIRED = list(FIELDS)
OPTION_FIELDS = ["option_a", "option_b", "option_c", "option_d"]
LETTERS = "ABCD"
# Columns of earlier templates. A file that still has them is refused, so a value such as marks=2, active=Inactive
# or training=... is never silently ignored.
OLD_COLUMNS = ["id", "training", "department", "competency", "type", "options_extra", "explanation", "difficulty", "marks", "level", "language", "active", "function"]

# Version of the saved preview payload. Previews validated with an earlier template must be validated again.
PAYLOAD_FORMAT = 3
IMPORT_LANGUAGE = "English"  # The existing internal default; no detection, no translation.
IMPORT_TYPE = QuestionType.MCQ_SINGLE.value
DEFAULT_MARKS = Decimal("1")
DEFAULT_DIFFICULTY = Difficulty.EASY.value

# Database and form limits (models.Question, question_bank.router.QuestionIn).
MAX_TOPIC = 160
MAX_TEXT = 4000
MIN_QUESTION = 3

CODE_PREFIX = "Q-"
CODE_RANDOM_BYTES = 5  # 10 hex characters: "Q-7F3A9C21B4", well inside question_code's 60 characters.


# ---------- Normalisation ----------

_QUOTES = str.maketrans({"‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"'})


def normalise(text: str | None) -> str:
    """Conservative: only differences a reader would not notice are ignored.

    Unicode compatibility forms (NFKC), curly quotes, runs of spaces and line breaks, leading and trailing spaces,
    and letter case. Punctuation and words are kept, so "What is KYC?" and "What is KYC" stay different.
    """
    text = unicodedata.normalize("NFKC", text or "").translate(_QUOTES)
    return " ".join(text.split()).casefold()


def content_key(question_text: str) -> str:
    """What identifies "the same question" within one training's test pool: its normalised text."""
    return normalise(question_text)


def answer_mode(question_type_value: str) -> str:
    """Single choice, True/False and Scenario all take one answer, so an existing Scenario question with the same
    content as an imported row is the same question, not a conflict."""
    return "multiple" if question_type_value == QuestionType.MCQ_MULTIPLE else "single"


def correct_letter(value: str) -> tuple[int | None, str | None]:
    """The index (0 to 3) of the one correct option, or a problem."""
    letters = [c for c in value.replace("|", ",").replace(";", ",").split(",") if c.strip()]
    if len(letters) > 1:
        return None, "Give exactly one correct letter: A, B, C or D."
    letter = value.strip().upper()
    if letter not in tuple(LETTERS):
        return None, "Use one letter: A, B, C or D."
    return LETTERS.index(letter), None


# ---------- Content comparison ----------

# Only what the department file supplies is compared. Marks, difficulty, explanation, competency and department
# are set by TrainCheck or edited later by L&D, so a question L&D has adjusted is still recognised as the same one.
COMPARED = {
    "options": "answer options",
    "correct": "correct answer",
    "topic": "topic",
    "mode": "single or multiple answer",
}


def signature(*, options: list[str], correct_texts: list[str], topic: str, question_type_value: str) -> dict:
    """Compared once two questions have the same text. Options are compared as a set (their letters are only
    positions) and the answer key by option text."""
    return {
        "options": frozenset(normalise(o) for o in options),
        "correct": frozenset(normalise(o) for o in correct_texts),
        "topic": normalise(topic),
        "mode": answer_mode(question_type_value),
    }


def payload_signature(payload: dict) -> dict:
    options = payload["options"]
    return signature(options=options, correct_texts=[options[i] for i in payload["correct"]], topic=payload["topic"], question_type_value=payload["question_type"])


def differences(a: dict, b: dict) -> list[str]:
    return [label for field, label in COMPARED.items() if a[field] != b[field]]


# ---------- Questions already in the pool ----------

class Existing:
    __slots__ = ("code", "status", "signature")

    def __init__(self, code: str, status: str, sig: dict) -> None:
        self.code, self.status, self.signature = code, status, sig


class Pool:
    """Questions already linked to one training that the selected test may draw: links for that test type and
    unclassified legacy links (which serve both tests). Inactive questions are included: they are still the same
    question. Questions linked to the training only for the other test type are kept apart, for a note only.

    Questions are compared with their current version, whatever their ID, type and however they were created.
    """

    def __init__(self, db: Session, training_id: uuid.UUID, test_type: str) -> None:
        self.in_scope: dict[str, list[Existing]] = {}
        self.other_test: dict[str, list[str]] = {}
        rows = db.execute(
            select(QuestionTrainingTag.test_type, Question)
            .join(Question, Question.id == QuestionTrainingTag.question_id)
            .options(selectinload(Question.options))
            .where(QuestionTrainingTag.training_id == training_id)
            .order_by(Question.question_code)
        ).all()
        ids = [q.id for _, q in rows]
        keys: dict[uuid.UUID, set[uuid.UUID]] = {}
        if ids:
            for question_id, option_id in db.execute(select(QuestionAnswerKey.question_id, QuestionAnswerKey.option_id).where(QuestionAnswerKey.question_id.in_(ids))):
                keys.setdefault(question_id, set()).add(option_id)
        for link_type, question in rows:
            key = content_key(question.question_text)
            if link_type is not None and link_type != test_type:
                self.other_test.setdefault(key, []).append(question.question_code)
                continue
            correct = keys.get(question.id, set())
            sig = signature(
                options=[o.option_text for o in question.options],
                correct_texts=[o.option_text for o in question.options if o.id in correct],
                topic=question.topic,
                question_type_value=question.question_type,
            )
            self.in_scope.setdefault(key, []).append(Existing(question.question_code, question.status, sig))

    def add(self, payload: dict, code: str) -> None:
        """A question just imported is part of the pool for the rows after it."""
        self.in_scope.setdefault(content_key(payload["question_text"]), []).append(Existing(code, "ACTIVE", payload_signature(payload)))

    def match(self, payload: dict, test_label: str) -> tuple[str, str] | None:
        """("DUPLICATE" | "CONFLICT", message) when the question is already in this pool, else None."""
        found = self.in_scope.get(content_key(payload["question_text"]))
        if not found:
            return None
        sig = payload_signature(payload)
        for existing in found:
            if existing.signature == sig:
                inactive = " It is Inactive: activate it in the Question Bank if it should be used." if existing.status != "ACTIVE" else ""
                return "DUPLICATE", f"The same question is already in this training's {test_label} pool as {existing.code}. The row was skipped; nothing was changed.{inactive}"
        first = found[0]
        codes = ", ".join(e.code for e in found)
        changed = ", ".join(differences(first.signature, sig))
        return "CONFLICT", (
            f"A question with the same text is already in this training's {test_label} pool ({codes}), but the {changed} differ. "
            f"Nothing was imported or changed. To correct the existing question, edit {first.code} in the Question Bank. "
            f"{GENERIC_STEM_HINT}"
        )

    def other_test_note(self, payload: dict, test_label: str, other_label: str) -> str | None:
        codes = self.other_test.get(content_key(payload["question_text"]))
        if not codes:
            return None
        return f"A question with the same text ({', '.join(codes)}) is in this training's {other_label} pool. Importing creates a separate {test_label} question; the existing question and its link are not changed."


GENERIC_STEM_HINT = (
    "If these are different questions that share generic wording (for example \"Which of the following is correct?\"), "
    "reword the question text so each one is distinct, or add the question in the Question Bank."
)


# ---------- Question IDs ----------

def new_code(db: Session, taken: set[str]) -> str:
    """A globally unique question ID, generated when the import is confirmed. The unique constraint on
    question_code is the final guarantee; the caller retries on the rare collision with a concurrent insert."""
    while True:
        code = f"{CODE_PREFIX}{secrets.token_hex(CODE_RANDOM_BYTES).upper()}"
        if code not in taken and not db.scalar(select(exists().where(Question.question_code == code))):
            taken.add(code)
            return code


# ---------- Department instructions (templates) ----------

# The rules every format shares. Each template adds only how its questions are laid out. No line may start with a
# field name followed by a colon: in the PDF template that would read as a question field.
RULES = [
    "Every question needs all seven fields: question, option_a, option_b, option_c, option_d, correct, topic.",
    "Give four different answer options, A to D, and exactly one correct letter (A, B, C or D) in the correct field.",
    "The topic field is a short topic name of up to 160 characters. Question text is 3 to 4,000 characters.",
    "Do not add any other fields. The training and the Pre-test or Post-test are chosen by L&D when importing.",
    "TrainCheck sets the rest: a question ID, 1 mark, Easy difficulty, Single choice, no competency or explanation.",
    "L&D can change marks, difficulty, competency and explanation in the Question Bank after import.",
    "Questions are saved as English and their text is never translated. L&D corrects Hindi or Hinglish ones in the Question Bank.",
    "Once L&D confirms the import, the questions are Active and can be drawn by the selected Pre-test or Post-test.",
    "A question already in the selected test's pool is skipped. The same text with changed options, answer or topic is flagged for review.",
]
SPREADSHEET_INSTRUCTIONS = [
    "TrainCheck question import template",
    "Write one question per row on the Questions sheet, under the column names in row 1. Only the first sheet is imported.",
    "Use plain values: formulas, macros and external links are rejected. Save CSV files as UTF-8 with the same columns.",
    *RULES,
    "Problems are reported by spreadsheet row number.",
]


def excerpt(text: str, limit: int = 90) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
