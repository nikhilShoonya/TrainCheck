"""employee joining date

Revision ID: a4d8e2c6b1f3
Revises: f9c3b7d2e8a1

Additive only: one nullable DATE column, employees.joining_date. No default, no backfill and no data change. Every
existing employee keeps NULL ("not recorded"). Employees created from the L&D Admin "Add Employee" feature record it.

Old application code ignores the column, so this can be applied before the new code is deployed. Adding a nullable
column without a default is a catalogue-only change in PostgreSQL (no table rewrite).
"""
import sqlalchemy as sa
from alembic import op

revision = 'a4d8e2c6b1f3'
down_revision = 'f9c3b7d2e8a1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('employees', sa.Column('joining_date', sa.Date(), nullable=True))


def downgrade() -> None:
    # Drops recorded joining dates. Downgrade the application first.
    op.drop_column('employees', 'joining_date')
