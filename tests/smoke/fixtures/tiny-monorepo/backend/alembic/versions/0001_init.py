"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-06-01 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
    )
    op.create_table(
        "items",
        sa.Column("id", sa.Integer, primary_key=True),
        # DELIBERATE DEFECT for database-readiness-audit + performance-audit:
        # owner_id is filtered on in items.list but has no index.
        sa.Column("owner_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("items")
    op.drop_table("users")
