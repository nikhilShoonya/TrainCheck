"""assessment schedule date: a post-test due on a chosen calendar date (schedule mode FIXED_DATE)

Revision ID: c3f81d2a6b90
Revises: a7c4e19b3d52

Additive only: one nullable column. Existing configurations keep NULL and their current schedule mode.
"""
from alembic import op
import sqlalchemy as sa


revision = 'c3f81d2a6b90'
down_revision = 'a7c4e19b3d52'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('assessment_configs', sa.Column('schedule_date', sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column('assessment_configs', 'schedule_date')
