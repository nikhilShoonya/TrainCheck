"""Behaviour follow-up: one cycle, 30 days after completion (the 60- and 90-day follow-ups are withdrawn).

Revision ID: a3d91c7e5b20
Revises: f2b6d8a4c1e9

Data only, no schema change:
- Every training that had follow-ups now has exactly [30]. A training with none ([]) keeps none.
- Open (unsubmitted, not cancelled) reviews of any non-30-day cycle are cancelled, so nobody is asked for a
  60- or 90-day self-assessment. Submitted reviews and the cycles themselves are kept as history.
Downgrade restores [30, 60, 90] on trainings that have a follow-up. Cancelled reviews are not reopened.
"""
from alembic import op

revision = 'a3d91c7e5b20'
down_revision = 'f2b6d8a4c1e9'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE trainings SET followup_days = '[30]' WHERE followup_days::text <> '[]'")
    op.execute(
        """
        UPDATE behaviour_reviews SET cancelled = true
        WHERE submitted_at IS NULL AND cancelled = false
          AND cycle_id IN (SELECT id FROM behaviour_review_cycles WHERE period_days <> 30)
        """
    )


def downgrade() -> None:
    op.execute("UPDATE trainings SET followup_days = '[30, 60, 90]' WHERE followup_days::text <> '[]'")
