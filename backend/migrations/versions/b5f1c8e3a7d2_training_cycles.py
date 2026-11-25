"""training cycles for re-training

Revision ID: b5f1c8e3a7d2
Revises: a9e5c2d7b4f1

Re-training after the final failed attempt now starts a new training cycle on the same assignment. The cycle needs a
new training completion, which schedules a post-test with fresh attempts. Earlier cycles stay as they are.

- enrolments.training_cycle, training_completions.training_cycle and assessment_obligations.training_cycle: INTEGER
  NOT NULL DEFAULT 1. Every existing row becomes cycle 1. Adding a column with a constant default is a
  catalogue-only change in PostgreSQL 11+ (no table rewrite).
- training_completions: the one-completion-per-assignment unique constraint becomes one completion per assignment
  and cycle (uq_completion_cycle). Existing rows all have cycle 1, so they satisfy it. A plain index on
  enrolment_id replaces the lookup the old constraint's index provided.

No row is deleted or changed. Old application code ignores the new columns, but would record a second-cycle
completion as a duplicate of the first, so deploy the new code with this migration.
"""
import sqlalchemy as sa
from alembic import op

revision = 'b5f1c8e3a7d2'
down_revision = 'a9e5c2d7b4f1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ('enrolments', 'training_completions', 'assessment_obligations'):
        op.add_column(table, sa.Column('training_cycle', sa.Integer(), server_default='1', nullable=False))
    op.create_index(op.f('ix_training_completions_enrolment_id'), 'training_completions', ['enrolment_id'], unique=False)
    op.create_unique_constraint('uq_completion_cycle', 'training_completions', ['enrolment_id', 'training_cycle'])
    op.drop_constraint('training_completions_enrolment_id_key', 'training_completions', type_='unique')


def downgrade() -> None:
    # Refused by the database once any assignment has a second-cycle completion: never delete those to go back.
    op.create_unique_constraint('training_completions_enrolment_id_key', 'training_completions', ['enrolment_id'])
    op.drop_constraint('uq_completion_cycle', 'training_completions', type_='unique')
    op.drop_index(op.f('ix_training_completions_enrolment_id'), table_name='training_completions')
    for table in ('assessment_obligations', 'training_completions', 'enrolments'):
        op.drop_column(table, 'training_cycle')
