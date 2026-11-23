"""Allow completed imports to be removed from Recent imports without deleting imported data."""
import sqlalchemy as sa
from alembic import op

revision = "a9e5c2d7b4f1"
down_revision = "a4d8e2c6b1f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("import_jobs", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("import_jobs", "deleted_at")
