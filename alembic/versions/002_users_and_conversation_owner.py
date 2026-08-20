"""Add users and conversation ownership.

Revision ID: 002_users_owner
Revises: 001_initial_chat
Create Date: 2026-08-18

Additive only:
- creates the users table
- adds conversations.user_id (nullable, so existing rows are kept)
- adds conversations.title (nullable) and backfills from the first user message
Does not drop conversations, messages, or existing data.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "002_users_owner"
down_revision: Union[str, Sequence[str], None] = "001_initial_chat"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.add_column(
        "conversations",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column("title", sa.Text(), nullable=True),
    )
    op.create_index("ix_conversations_user_id", "conversations", ["user_id"], unique=False)
    op.create_foreign_key(
        "fk_conversations_user_id_users",
        "conversations",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.execute(
        sa.text(
            """
            UPDATE conversations AS c
            SET title = sub.preview
            FROM (
                SELECT DISTINCT ON (m.conversation_id)
                    m.conversation_id,
                    left(regexp_replace(trim(m.content), '\\s+', ' ', 'g'), 64) AS preview
                FROM messages AS m
                WHERE m.role = 'user' AND trim(m.content) <> ''
                ORDER BY m.conversation_id, m.created_at ASC, m.id ASC
            ) AS sub
            WHERE c.id = sub.conversation_id
              AND (c.title IS NULL OR btrim(c.title) = '')
            """
        )
    )


def downgrade() -> None:
    op.drop_constraint("fk_conversations_user_id_users", "conversations", type_="foreignkey")
    op.drop_index("ix_conversations_user_id", table_name="conversations")
    op.drop_column("conversations", "title")
    op.drop_column("conversations", "user_id")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
