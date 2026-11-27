"""Store the official 11-question training form without relabeling historical five-question responses."""
import sqlalchemy as sa
from alembic import op

revision = "fa27b6c8d901"
down_revision = "b5f1c8e3a7d2"
branch_labels = None
depends_on = None

LEGACY = ("relevance_rating", "clarity_rating", "alignment_rating", "fairness_rating", "confidence_rating")


def upgrade() -> None:
    op.add_column("assessment_feedback", sa.Column("training_ratings", sa.JSON(), nullable=True))
    for column in LEGACY:
        op.alter_column("assessment_feedback", column, existing_type=sa.Integer(), nullable=True)
    op.create_check_constraint("ck_feedback_questionnaire_present", "assessment_feedback", "training_ratings IS NOT NULL OR (" + " AND ".join(f"{c} IS NOT NULL" for c in LEGACY) + ")")


def downgrade() -> None:
    # New answers cannot be truthfully converted to the old questions. Refuse a lossy downgrade.
    connection = op.get_bind()
    if connection.scalar(sa.text("SELECT count(*) FROM assessment_feedback WHERE training_ratings IS NOT NULL")):
        raise RuntimeError("Official training feedback exists; export and preserve these responses before downgrading.")
    op.drop_constraint("ck_feedback_questionnaire_present", "assessment_feedback", type_="check")
    for column in LEGACY:
        op.alter_column("assessment_feedback", column, existing_type=sa.Integer(), nullable=False)
    op.drop_column("assessment_feedback", "training_ratings")
