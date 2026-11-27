"""Official training feedback; legacy question identities stay separate for historical responses."""

STANDARD_OPTIONS = [(1, "Very Poor"), (2, "Poor"), (3, "Neutral"), (4, "Good"), (5, "Excellent")]
# Preserve the official display order. Scores follow meaning, so Exceptional remains the highest.
TRAINER_OPTIONS = [(2, "Fair"), (4, "Very good"), (5, "Exceptional"), (3, "Average"), (1, "Below average")]


def question(key: str, section: str, short_label: str, text: str, options=None, *, stars=False) -> dict:
    choices = options or STANDARD_OPTIONS
    return {"key": key, "section": section, "short_label": short_label, "text": text,
            "options": [{"value": value, "label": label} for value, label in choices],
            "stars": stars, "low_label": min(choices)[1], "high_label": max(choices)[1]}


QUESTIONS = [
    question("satisfaction", "Overall Training Satisfaction", "Overall satisfaction", "How satisfied are you with the training quality and effectiveness?", [(n, f"{n} star{'s' if n != 1 else ''}") for n in range(1, 6)], stars=True),
    question("role_relevance", "Training Content Relevance & Clarity", "Role relevance", "The training content was directly relevant to my role and responsibilities."),
    question("objectives", "Training Content Relevance & Clarity", "Learning objectives", "The learning objectives were clearly defined from the start."),
    question("applicability", "Training Content Relevance & Clarity", "Practical applicability", "The topics covered were applicable to real-world scenarios in my job."),
    question("interaction", "Training Delivery & Engagement", "Interaction", "Interactive elements (e.g., discussions, Q&A) kept me involved throughout the session."),
    question("pace", "Training Delivery & Engagement", "Pace and structure", "The session's pace and structure held my attention effectively."),
    question("trainer_preparation", "Trainer Expertise & Preparation", "Trainer preparation", "The session was well-prepared and organized.", TRAINER_OPTIONS),
    question("materials", "Training Materials & Resources", "Materials and resources", "The overall quality of the materials met or exceeded my expectations."),
    question("environment", "Training Environment & Logistics", "Learning environment", "The training environment (physical or virtual) was conducive to learning."),
    question("logistics", "Training Environment & Logistics", "Technical and logistical support", "Any technical or logistical issues were minimal and quickly resolved."),
]

# Retained only when reading feedback submitted before the duplicate was removed.
RETIRED_TRAINER_QUESTION = question("trainer_organisation", "Trainer Expertise & Preparation", "Trainer preparation (previous duplicate)", "The session was well-prepared and organized.", TRAINER_OPTIONS)

LEGACY_COLUMNS = {key: f"{key}_rating" for key in ("relevance", "clarity", "alignment", "fairness", "confidence")}
LEGACY_QUESTIONS = [
    question("relevance", "Previous feedback form", "Relevance (previous form)", "How relevant was this training to your day-to-day role?", [(1, "Not relevant"), (5, "Highly relevant")]),
    question("clarity", "Previous feedback form", "Clarity (previous form)", "How clearly were the training content and examples explained?", [(1, "Very unclear"), (5, "Very clear")]),
    question("alignment", "Previous feedback form", "Assessment match (previous form)", "How well did the assessment questions match what was taught in the training?", [(1, "Not at all"), (5, "Very well")]),
    question("fairness", "Previous feedback form", "Fairness (previous form)", "How fair were the assessment's difficulty level and time limit?", [(1, "Very unfair"), (5, "Very fair")]),
    question("confidence", "Previous feedback form", "Confidence (previous form)", "How confident are you to apply what you learned in your daily work?", [(1, "Not confident"), (5, "Very confident")]),
]
LABELS = {q["key"]: q["short_label"] for q in QUESTIONS + [RETIRED_TRAINER_QUESTION] + LEGACY_QUESTIONS}
