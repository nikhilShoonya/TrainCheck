"""answer revision: a per-answer counter for compare-and-set saves

Revision ID: c7d1e5a9f3b2
Revises: b8e2f4a6c1d3

Additive only: one integer column with a server default, so existing rows read as revision 0 and
older clients that send no base revision keep working.
"""
import sqlalchemy as sa
from alembic import op

revision = 'c7d1e5a9f3b2'
down_revision = 'b8e2f4a6c1d3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('attempt_answers', sa.Column('revision', sa.Integer(), nullable=False, server_default='0'))


def downgrade() -> None:
    op.drop_column('attempt_answers', 'revision')
