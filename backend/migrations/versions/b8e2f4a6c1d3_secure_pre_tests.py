"""Pre-tests run in the secure assessment environment: full screen on for active pre-test configurations.

Revision ID: b8e2f4a6c1d3
Revises: a3d91c7e5b20

Until now the configuration form could not turn full screen on for a pre-test (it always saved it off), so an
"off" value on a pre-test was never an L&D decision. Active pre-test configurations are switched on. Earlier
versions are left as they were: attempts keep the snapshot they were taken under.
"""
from alembic import op

revision = 'b8e2f4a6c1d3'
down_revision = 'a3d91c7e5b20'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE assessment_configs SET require_fullscreen = true WHERE assessment_type = 'PRE_TEST' AND is_active")


def downgrade() -> None:
    op.execute("UPDATE assessment_configs SET require_fullscreen = false WHERE assessment_type = 'PRE_TEST' AND is_active")
