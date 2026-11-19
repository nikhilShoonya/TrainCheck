"""assessment schedule time: the exact UTC opening moment of a custom-date assessment

Revision ID: d8e2f6b0a4c3
Revises: c7d1e5a9f3b2

Additive only: one nullable column. Existing custom-date configurations keep it empty and keep opening at the
start of their date in the organisation timezone, exactly as before. No existing row is changed.
"""
import sqlalchemy as sa
from alembic import op

revision = 'd8e2f6b0a4c3'
down_revision = 'c7d1e5a9f3b2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('assessment_configs', sa.Column('schedule_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('assessment_configs', 'schedule_at')
