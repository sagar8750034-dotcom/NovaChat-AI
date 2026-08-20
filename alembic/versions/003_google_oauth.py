"""Add Google identity fields to users.

Revision ID: 003_google_oauth
Revises: 002_users_owner
Create Date: 2026-08-18

Additive only:
- adds users.google_sub (nullable, unique)
- adds users.picture_url (nullable)
- makes users.password_hash nullable so Google accounts do not need a password
Does not drop users, conversations, messages, or existing rows.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003_google_oauth"
down_revision: Union[str, Sequence[str], None] = "002_users_owner"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("google_sub", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("picture_url", sa.Text(), nullable=True),
    )
    op.create_index("ix_users_google_sub", "users", ["google_sub"], unique=True)
    op.alter_column(
        "users",
        "password_hash",
        existing_type=sa.Text(),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "users",
        "password_hash",
        existing_type=sa.Text(),
        nullable=False,
    )
    op.drop_index("ix_users_google_sub", table_name="users")
    op.drop_column("users", "picture_url")
    op.drop_column("users", "google_sub")
