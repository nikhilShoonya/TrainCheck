"""answer operation id: which save wrote the current answer

Revision ID: e1a7c3d9f5b4
Revises: d8e2f6b0a4c3

Additive only: one nullable column. A save names a random operation ID; the server keeps the ID of the save that
produced the current revision and reports it on a conflict, so a page can tell its own lost save from another
window's or device's save without guessing from the selected options. Existing rows keep it empty.
"""
import sqlalchemy as sa
from alembic import op

revision = 'e1a7c3d9f5b4'
down_revision = 'd8e2f6b0a4c3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('attempt_answers', sa.Column('last_op_id', sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column('attempt_answers', 'last_op_id')
