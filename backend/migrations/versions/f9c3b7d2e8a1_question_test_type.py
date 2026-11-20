"""question test type: separate pre-test and post-test question pools per training

Revision ID: f9c3b7d2e8a1
Revises: e1a7c3d9f5b4

Additive only: two nullable columns, each with a CHECK that allows NULL, PRE_TEST or POST_TEST. No backfill and no
data change.

- question_training_tags.test_type: which test of that training may draw the question. Every existing link keeps
  NULL, the legacy "unclassified" value, which the application treats as eligible for both the pre-test and the
  post-test of that training, exactly as before this revision. Existing links are never guessed into one pool.
- import_jobs.test_type: the test type chosen in the Import Centre with the training. Existing jobs keep NULL.
  A question import still READY with NULL cannot be committed; it must be edited and validated again.

Old application code ignores both columns, so this can be applied before the new code is deployed. Adding a
nullable column without a default is a catalogue-only change in PostgreSQL; each CHECK briefly scans its table.
"""
import sqlalchemy as sa
from alembic import op

revision = 'f9c3b7d2e8a1'
down_revision = 'e1a7c3d9f5b4'
branch_labels = None
depends_on = None

ALLOWED = "test_type IS NULL OR test_type IN ('PRE_TEST', 'POST_TEST')"


def upgrade() -> None:
    op.add_column('question_training_tags', sa.Column('test_type', sa.String(length=10), nullable=True))
    op.create_check_constraint('ck_question_training_tags_test_type', 'question_training_tags', ALLOWED)
    op.add_column('import_jobs', sa.Column('test_type', sa.String(length=10), nullable=True))
    op.create_check_constraint('ck_import_jobs_test_type', 'import_jobs', ALLOWED)


def downgrade() -> None:
    # Drops the classification. Every link becomes unclassified again (eligible for both tests), which is the
    # behaviour of the code before this revision; downgrade the application first.
    op.drop_constraint('ck_import_jobs_test_type', 'import_jobs', type_='check')
    op.drop_column('import_jobs', 'test_type')
    op.drop_constraint('ck_question_training_tags_test_type', 'question_training_tags', type_='check')
    op.drop_column('question_training_tags', 'test_type')
