"""assessment feedback: five 1-5 ratings and an optional comment after a post-training assessment

Revision ID: f2b6d8a4c1e9
Revises: d5a2e7c91f04

Additive only: one new table, one row per assessment obligation.
"""
from alembic import op
import sqlalchemy as sa


revision = 'f2b6d8a4c1e9'
down_revision = 'd5a2e7c91f04'
branch_labels = None
depends_on = None

RATINGS = ('relevance_rating', 'clarity_rating', 'alignment_rating', 'fairness_rating', 'confidence_rating')


def upgrade() -> None:
    op.create_table(
        'assessment_feedback',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('obligation_id', sa.Uuid(), nullable=False),
        sa.Column('attempt_id', sa.Uuid(), nullable=False),
        sa.Column('employee_id', sa.Uuid(), nullable=False),
        sa.Column('training_id', sa.Uuid(), nullable=False),
        *[sa.Column(name, sa.Integer(), nullable=False) for name in RATINGS],
        sa.Column('comment_text', sa.Text(), nullable=True),
        sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=False),
        *[sa.CheckConstraint(f'{name} BETWEEN 1 AND 5', name=f'ck_feedback_{name}') for name in RATINGS],
        sa.ForeignKeyConstraint(['obligation_id'], ['assessment_obligations.id']),
        sa.ForeignKeyConstraint(['attempt_id'], ['assessment_attempts.id']),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id']),
        sa.ForeignKeyConstraint(['training_id'], ['trainings.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('obligation_id'),
    )
    op.create_index(op.f('ix_assessment_feedback_employee_id'), 'assessment_feedback', ['employee_id'])
    op.create_index(op.f('ix_assessment_feedback_training_id'), 'assessment_feedback', ['training_id'])
    op.create_index(op.f('ix_assessment_feedback_submitted_at'), 'assessment_feedback', ['submitted_at'])


def downgrade() -> None:
    op.drop_index(op.f('ix_assessment_feedback_submitted_at'), table_name='assessment_feedback')
    op.drop_index(op.f('ix_assessment_feedback_training_id'), table_name='assessment_feedback')
    op.drop_index(op.f('ix_assessment_feedback_employee_id'), table_name='assessment_feedback')
    op.drop_table('assessment_feedback')
