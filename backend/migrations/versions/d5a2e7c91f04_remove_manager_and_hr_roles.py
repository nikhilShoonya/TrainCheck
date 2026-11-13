"""remove the Manager and HR / Leadership roles

Revision ID: d5a2e7c91f04
Revises: c3f81d2a6b90

Every account that held MANAGER or HR_READ_ONLY keeps (or is given) the EMPLOYEE role, so nobody loses
their sign-in. The two role assignments and role rows are then deleted.

Reporting lines (manager_assignments) and past behaviour reviews are left untouched: the data is kept,
the application no longer reads it.

Downgrade recreates the two role rows only. Which accounts held them is not restored.
"""
import uuid

from alembic import op
import sqlalchemy as sa


revision = 'd5a2e7c91f04'
down_revision = 'c3f81d2a6b90'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    employee_role = bind.execute(sa.text("SELECT id FROM roles WHERE code = 'EMPLOYEE'")).scalar()
    if employee_role is None:
        employee_role = uuid.uuid4()
        bind.execute(sa.text("INSERT INTO roles (id, code, name) VALUES (:id, 'EMPLOYEE', 'Employee')"), {"id": employee_role})
    # Keep everyone able to sign in as an employee.
    bind.execute(
        sa.text(
            """
            INSERT INTO user_roles (user_account_id, role_id)
            SELECT DISTINCT ur.user_account_id, :employee_role
            FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            WHERE r.code IN ('MANAGER', 'HR_READ_ONLY')
              AND NOT EXISTS (SELECT 1 FROM user_roles x WHERE x.user_account_id = ur.user_account_id AND x.role_id = :employee_role)
            """
        ),
        {"employee_role": employee_role},
    )
    bind.execute(sa.text("DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE code IN ('MANAGER', 'HR_READ_ONLY'))"))
    bind.execute(sa.text("DELETE FROM roles WHERE code IN ('MANAGER', 'HR_READ_ONLY')"))


def downgrade() -> None:
    bind = op.get_bind()
    for code, name in (("MANAGER", "Manager"), ("HR_READ_ONLY", "HR / Leadership")):
        exists = bind.execute(sa.text("SELECT 1 FROM roles WHERE code = :code"), {"code": code}).scalar()
        if not exists:
            bind.execute(sa.text("INSERT INTO roles (id, code, name) VALUES (:id, :code, :name)"), {"id": uuid.uuid4(), "code": code, "name": name})
