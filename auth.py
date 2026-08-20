"""Session authentication helpers for NovaChat (email/password + Google OAuth)."""
import os
import re
from functools import wraps
from urllib.parse import urlencode, urlparse
from uuid import UUID

from dotenv import dotenv_values
from flask import jsonify, redirect, session as flask_session
from werkzeug.security import check_password_hash, generate_password_hash

from models import User

# Canonical local development callback. Never derive this from request.host / LAN IP.
LOCAL_GOOGLE_REDIRECT_URI = "http://127.0.0.1:5002/auth/google/callback"
_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
NAME_MAX = 80
PASSWORD_MIN = 8
PASSWORD_MAX = 128
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _oauth_env(name):
    """Read an OAuth setting without logging it.

    Prefer the project .env file over a stale process environment value so a
    previously loaded GOOGLE_REDIRECT_URI cannot silently keep an old path.
    """
    from_file = (dotenv_values(_ENV_PATH).get(name) or "").strip().strip('"').strip("'")
    from_os = (os.getenv(name) or "").strip().strip('"').strip("'")
    return from_file or from_os


def _is_forbidden_redirect_host(hostname):
    """Reject localhost / private LAN hosts that cause redirect_uri_mismatch."""
    if not hostname:
        return True
    host = hostname.lower().strip("[]")
    if host == "localhost":
        return True
    if host.startswith("10.") or host.startswith("192.168.") or host.startswith("172."):
        # 172.16.0.0 – 172.31.255.255 is private; keep the check simple for common LAN IPs.
        if host.startswith("172."):
            try:
                second = int(host.split(".")[1])
                if 16 <= second <= 31:
                    return True
            except (IndexError, ValueError):
                return True
        else:
            return True
    return False


def validate_google_oauth_env():
    """
    Validate Google OAuth env vars.

    Returns (config_dict_or_None, error_message_or_None).
    config is None when Google is intentionally unconfigured (all three empty).
    error is set when configuration is partial or invalid.
    """
    client_id = _oauth_env("GOOGLE_CLIENT_ID")
    client_secret = _oauth_env("GOOGLE_CLIENT_SECRET")
    redirect_uri = _oauth_env("GOOGLE_REDIRECT_URI")

    any_set = bool(client_id or client_secret or redirect_uri)
    all_set = bool(client_id and client_secret and redirect_uri)
    if not any_set:
        return None, None
    if not all_set:
        missing = [
            name
            for name, value in (
                ("GOOGLE_CLIENT_ID", client_id),
                ("GOOGLE_CLIENT_SECRET", client_secret),
                ("GOOGLE_REDIRECT_URI", redirect_uri),
            )
            if not value
        ]
        return None, (
            "Google OAuth is partially configured. Set these environment variables: "
            + ", ".join(missing)
        )

    parsed = urlparse(redirect_uri)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or not parsed.path:
        return None, (
            "GOOGLE_REDIRECT_URI must be an absolute URL, e.g. "
            + LOCAL_GOOGLE_REDIRECT_URI
        )
    if parsed.path.rstrip("/") != "/auth/google/callback":
        return None, (
            "GOOGLE_REDIRECT_URI path must be exactly /auth/google/callback "
            f"(got {parsed.path!r})."
        )
    if _is_forbidden_redirect_host(parsed.hostname):
        return None, (
            "GOOGLE_REDIRECT_URI must not use localhost or a LAN IP. "
            f"For local development use exactly: {LOCAL_GOOGLE_REDIRECT_URI}"
        )

    # Local development must use the single canonical callback.
    if parsed.hostname == "127.0.0.1":
        if redirect_uri != LOCAL_GOOGLE_REDIRECT_URI:
            return None, (
                "For local development GOOGLE_REDIRECT_URI must exactly equal "
                f"{LOCAL_GOOGLE_REDIRECT_URI}"
            )
    elif parsed.scheme != "https":
        return None, (
            "Production GOOGLE_REDIRECT_URI must use https:// "
            f"(or the local URI {LOCAL_GOOGLE_REDIRECT_URI})."
        )

    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
    }, None


def google_oauth_config():
    """Return validated Google OAuth settings from env, or None if not configured."""
    config, error = validate_google_oauth_env()
    if error:
        return None
    return config


def login_user(user):
    flask_session.clear()
    flask_session["user_id"] = str(user.id)
    flask_session.permanent = True


def logout_user():
    flask_session.clear()


def public_user(user):
    return {
        "id": str(user.id),
        "name": user.name,
        "email": user.email,
        "picture": user.picture_url,
    }


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not flask_session.get("user_id"):
            return jsonify({"error": "Please log in to continue."}), 401
        return view(*args, **kwargs)
    return wrapped


def load_user(db_session):
    uid = flask_session.get("user_id")
    if not uid:
        return None
    try:
        return db_session.get(User, UUID(str(uid)))
    except (ValueError, TypeError):
        return None


def hash_password(password):
    # Pin algorithm + iterations so signup and login always use the same verifier.
    # Explicit iteration count avoids Werkzeug's default 1,000,000-round pbkdf2,
    # which can stall long enough for Neon to drop the checked-out connection.
    return generate_password_hash(password, method="pbkdf2:sha256:260000")


def verify_password(password_hash, password):
    if not password_hash or password is None:
        return False
    return check_password_hash(str(password_hash), str(password))


def normalize_email(email):
    return (email or "").strip().lower()


def validate_signup(name, email, password, confirm):
    name = (name or "").strip()
    email = normalize_email(email)
    password = password or ""
    confirm = confirm or ""

    if not name:
        return None, "Please enter your name."
    if len(name) > NAME_MAX:
        return None, "Name is too long."
    if not email or not EMAIL_RE.match(email):
        return None, "Please enter a valid email address."
    if len(password) < PASSWORD_MIN:
        return None, "Password must be at least 8 characters."
    if len(password) > PASSWORD_MAX:
        return None, "Password is too long."
    if password != confirm:
        return None, "Passwords do not match."
    return {"name": name, "email": email, "password": password}, None


def validate_login(email, password):
    email = normalize_email(email)
    password = password or ""
    if not email or not EMAIL_RE.match(email):
        return None, "Please enter a valid email address."
    if not password:
        return None, "Please enter your password."
    return {"email": email, "password": password}, None


def google_unconfigured_message(debug=False):
    if debug:
        return (
            "Google sign-in is not configured. Add GOOGLE_CLIENT_ID and "
            "GOOGLE_CLIENT_SECRET to .env, set GOOGLE_REDIRECT_URI to "
            f"{LOCAL_GOOGLE_REDIRECT_URI}, and register that exact URI in "
            "Google Cloud Console."
        )
    return "Google sign-in is not available right now."


def google_profile_from_userinfo(info):
    """Build a local profile from Google's verified OIDC userinfo. Never stores a password."""
    if not info:
        raise ValueError("Google did not return a user profile.")
    if info.get("email_verified") not in (True, "true"):
        raise ValueError("Google email is not verified.")
    email = normalize_email(info.get("email"))
    sub = info.get("sub")
    if not email or not sub:
        raise ValueError("Google account is missing identity details.")
    name = (info.get("name") or email.split("@")[0]).strip()[:NAME_MAX]
    if not name:
        name = email.split("@")[0][:NAME_MAX]
    return {
        "google_sub": str(sub),
        "email": email,
        "name": name,
        "picture": (info.get("picture") or "").strip() or None,
    }


def oauth_error_redirect(message):
    return redirect("/?" + urlencode({"auth_error": message}))


def upsert_google_user(db_session, profile):
    """Find or create a user from a verified Google profile. Never stores a Google password."""
    user = (
        db_session.query(User)
        .filter(User.google_sub == profile["google_sub"])
        .one_or_none()
    )
    if user is None:
        user = db_session.query(User).filter(User.email == profile["email"]).one_or_none()

    if user is None:
        user = User(
            name=profile["name"],
            email=profile["email"],
            google_sub=profile["google_sub"],
            picture_url=profile["picture"],
            password_hash=None,
        )
        db_session.add(user)
    else:
        user.google_sub = profile["google_sub"]
        user.email = profile["email"]
        if profile["name"]:
            user.name = profile["name"]
        if profile["picture"]:
            user.picture_url = profile["picture"]

    db_session.commit()
    db_session.refresh(user)
    return user
