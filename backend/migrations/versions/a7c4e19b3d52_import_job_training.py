"""import job training: the training selected for a question-bank import

Revision ID: a7c4e19b3d52
Revises: e0f4968d8aea

Additive only: one nullable column. Existing import jobs keep NULL, which means "file-based": each row
named its own training. ON DELETE SET NULL keeps import history when a draft training is deleted.
"""
import sqlalchemy as sa
from alembic import op

revision = 'a7c4e19b3d52'
down_revision = 'e0f4968d8aea'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('import_jobs', sa.Column('training_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_import_jobs_training_id'), 'import_jobs', ['training_id'], unique=False)
    op.create_foreign_key('fk_import_jobs_training_id_trainings', 'import_jobs', 'trainings', ['training_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    op.drop_constraint('fk_import_jobs_training_id_trainings', 'import_jobs', type_='foreignkey')
    op.drop_index(op.f('ix_import_jobs_training_id'), table_name='import_jobs')
    op.drop_column('import_jobs', 'training_id')
