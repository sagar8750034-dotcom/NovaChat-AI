"""SQLAlchemy engine and session for Neon PostgreSQL."""
import os

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.orm import scoped_session, sessionmaker

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip()


def normalize_database_url(url):
    """Use the psycopg2 driver with SQLAlchemy for this Flask (sync) app."""
    if not url:
        return url
    if url.startswith("postgres://"):
        url = "postgresql+psycopg2://" + url[len("postgres://"):]
    elif url.startswith("postgresql://") and "+psycopg" not in url:
        url = "postgresql+psycopg2://" + url[len("postgresql://"):]
    return url


def create_db_engine(url):
    """Cloud-friendly pooling for Neon's serverless Postgres."""
    return create_engine(
        normalize_database_url(url),
        pool_pre_ping=True,
        pool_recycle=280,
        pool_size=5,
        max_overflow=5,
        pool_timeout=30,
    )


engine = create_db_engine(DATABASE_URL) if DATABASE_URL else None
SessionLocal = scoped_session(
    sessionmaker(autocommit=False, autoflush=False, bind=engine)
) if engine is not None else None


def get_session():
    if SessionLocal is None:
        raise RuntimeError(
            "DATABASE_URL is not set. Add your Neon connection string to .env."
        )
    return SessionLocal()


def ping_database():
    """Return (ok: bool, detail: str). Raises nothing; used by health checks."""
    if not DATABASE_URL:
        return False, "DATABASE_URL is missing from the environment."
    if engine is None:
        return False, "Database engine was not created."
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True, "connected"
    except Exception as exc:
        return False, str(exc)
