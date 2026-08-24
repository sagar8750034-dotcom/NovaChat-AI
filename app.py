"""
Flask backend for the Chatbox UI.
- Serves the existing index.html / styles.css / script.js
- Proxies chat to Google Gemini (API key stays server-side)
"""
import json
import os
import time
from datetime import timedelta
from uuid import UUID

import requests
from authlib.integrations.flask_client import OAuth
from authlib.integrations.base_client.errors import MismatchingStateError, OAuthError
from dotenv import load_dotenv
from flask import (
    Flask,
    jsonify,
    request,
    send_from_directory,
    Response,
    redirect,
    session as flask_session,
    stream_with_context,
)
from flask_cors import CORS
from flasgger import Swagger
from sqlalchemy import case, or_, func, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from werkzeug.middleware.proxy_fix import ProxyFix

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Load project .env first and override stale process env so GOOGLE_REDIRECT_URI
# cannot keep an old /api/auth/google/callback value after .env is updated.
load_dotenv(os.path.join(BASE_DIR, ".env"), override=True)

from auth import (
    google_profile_from_userinfo,
    google_unconfigured_message,
    hash_password,
    load_user,
    login_required,
    login_user,
    logout_user,
    oauth_error_redirect,
    public_user,
    upsert_google_user,
    normalize_email,
    validate_google_oauth_env,
    validate_login,
    validate_signup,
    verify_password,
    frontend_redirect,
)
from db import SessionLocal, get_session, ping_database
from models import Conversation, Message, User, utcnow
from tts import TtsConfigError, TtsError, synthesize_speech, tts_configured

MESSAGE_MAX_CHARS = 8000

API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")

# Friendly NovaChat personality + concise replies
SYSTEM_INSTRUCTION = (
    "You are NovaChat AI — a friendly, natural, and conversational companion. "
    "Be approachable and talk like a real person in chat, using simple natural language. "
    "Avoid overly formal, corporate, or customer-support sounding phrases. "
    "Match the user's language: Hindi, Hinglish, or English — reply in the same style. "
    "For casual conversation, respond casually and naturally. "
    "For serious or technical questions, stay clear, respectful, and helpful, "
    "but still conversational — not stiff. "
    "Use conversation history to understand follow-ups and references like 'it' or 'that'. "
    "Keep normal responses concise: usually 1-3 short paragraphs, "
    "or at most 3-5 bullet points only when bullets truly help. "
    "Don't use unnecessary headings or bullet points for simple questions. "
    "Use emojis occasionally when they fit naturally, but don't overuse them. "
    "Don't repeatedly say phrases like 'How may I assist you today?' "
    "Don't say 'As an AI language model' unless genuinely necessary. "
    "Only give detailed answers when the user asks for details."
)

app = Flask(__name__, static_folder=None)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Cross-origin frontend (Netlify) → API (Render). Comma-separated origins only.
# Example: CORS_ORIGINS=https://your-site.netlify.app,http://127.0.0.1:5500
_cors_origins = [
    origin.strip().rstrip("/")
    for origin in (os.getenv("CORS_ORIGINS") or "").split(",")
    if origin.strip()
]
_frontend_origin = (os.getenv("FRONTEND_ORIGIN") or "").strip().rstrip("/")
if _frontend_origin and _frontend_origin not in _cors_origins:
    _cors_origins.append(_frontend_origin)

if _cors_origins:
    CORS(
        app,
        resources={
            r"/api/*": {"origins": _cors_origins},
            r"/auth/*": {"origins": _cors_origins},
        },
        supports_credentials=True,
    )
else:
    # Same-origin / local monolith (Flask serves the UI).
    CORS(app)

_secret = (os.getenv("SECRET_KEY") or "").strip()
if not _secret:
    app.logger.warning(
        "SECRET_KEY is not set. Sessions will reset when the server restarts. "
        "Add SECRET_KEY to .env for persistent logins."
    )
    _secret = os.urandom(32)
app.secret_key = _secret

# Cookie settings for Netlify (HTTPS) + Render (HTTPS) split hosting:
# SameSite=None + Secure are required for cross-site credentialed fetches.
_same_site = (os.getenv("SESSION_COOKIE_SAMESITE") or "").strip() or (
    "None" if _frontend_origin else "Lax"
)
_cookie_secure_env = os.getenv("SESSION_COOKIE_SECURE", "").strip().lower()
if _cookie_secure_env in ("1", "true", "yes"):
    _cookie_secure = True
elif _cookie_secure_env in ("0", "false", "no"):
    _cookie_secure = False
else:
    # Default Secure when cross-origin frontend is configured (browsers require it with SameSite=None).
    _cookie_secure = _same_site.lower() == "none" or bool(_frontend_origin)

app.config.update(
    SESSION_COOKIE_NAME="novachat_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE=_same_site,
    SESSION_COOKIE_SECURE=_cookie_secure,
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
)

# Google OAuth (Authlib). Credentials come only from environment variables:
# GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI.
# redirect_uri is NEVER taken from request.host_url / localhost / LAN IP.
# Never log client_secret or tokens.
oauth = OAuth(app)
_google_oauth_registered = False
_google_oauth_config_cache = None
_google_oauth_config_error = None


def _load_google_oauth_config():
    """Load and cache validated Google OAuth config. Never logs secrets."""
    global _google_oauth_config_cache, _google_oauth_config_error
    if _google_oauth_config_cache is not None or _google_oauth_config_error is not None:
        return _google_oauth_config_cache, _google_oauth_config_error
    config, error = validate_google_oauth_env()
    _google_oauth_config_cache = config
    _google_oauth_config_error = error
    return config, error


def _ensure_google_oauth():
    """Register the Google OIDC client once when credentials exist. Never logs secrets."""
    global _google_oauth_registered
    config, error = _load_google_oauth_config()
    if error or config is None:
        return None
    if not _google_oauth_registered:
        # Pin redirect_uri on the client so Authlib never rebuilds it from the request host.
        oauth.register(
            name="google",
            client_id=config["client_id"],
            client_secret=config["client_secret"],
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={
                "scope": "openid email profile",
                "prompt": "select_account",
            },
            redirect_uri=config["redirect_uri"],
        )
        _google_oauth_registered = True
        app.logger.info(
            "Google OAuth configured. redirect_uri=%s",
            config["redirect_uri"],
        )
    return config


# Validate Google OAuth configuration at startup (clear error if partial/invalid).
_startup_google_config, _startup_google_error = _load_google_oauth_config()
if _startup_google_error:
    app.logger.error("Google OAuth configuration error: %s", _startup_google_error)
elif _startup_google_config is None:
    app.logger.warning(
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, "
        "GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to enable Continue with Google."
    )
else:
    app.logger.info(
        "Google OAuth ready. Using redirect_uri=%s",
        _startup_google_config["redirect_uri"],
    )
    _ensure_google_oauth()


swagger = Swagger(
    app,
    template={
        "swagger": "2.0",
        "info": {
            "title": "NovaChat AI API",
            "description": (
                "REST API for the NovaChat AI Flask backend. "
                "Authentication, chat, conversation history, message edits, and text-to-speech. "
                "Server credentials stay on the backend and are not included in this spec."
            ),
            "version": "1.0.0",
        },
        "basePath": "/",
        "schemes": ["http", "https"],
        "consumes": ["application/json"],
        "produces": ["application/json"],
    },
    config={
        "headers": [],
        "specs": [
            {
                "endpoint": "apispec",
                "route": "/apispec.json",
                "rule_filter": lambda rule: str(rule.rule).startswith("/api/"),
                "model_filter": lambda tag: True,
            }
        ],
        "static_url_path": "/flasgger_static",
        "swagger_ui": True,
        "specs_route": "/docs",
    },
)


def _perf_ms(started):
    return int((time.perf_counter() - started) * 1000)


def _chat_timing(label, started, **extra):
    """Temporary DIAGNOSTIC latency logs — search for '[chat timing]'."""
    parts = " ".join(f"{key}={value}" for key, value in extra.items())
    line = f"[chat timing] {label} +{_perf_ms(started)}ms" + (f" {parts}" if parts else "")
    # print so numbers always show in the Flask terminal (logger can be quiet)
    print(line, flush=True)
    app.logger.info(line)


def extract_gemini_text(resp_json):
    """Pull plain text out of a Gemini generateContent / stream chunk."""
    try:
        candidates = resp_json.get("candidates") or []
        if not candidates:
            return None
        content = candidates[0].get("content") or {}
        parts = content.get("parts") or []
        texts = [p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text")]
        return "\n".join(texts) if texts else None
    except (AttributeError, IndexError, KeyError, TypeError):
        return None


def session_owner_id():
    """Owner UUID from the Flask session — no DB round-trip."""
    return _parse_uuid(flask_session.get("user_id"))


def build_contents(data):
    """
    Prefer full conversation history:
      {"messages": [{"role": "user"|"assistant", "content": "..."}, ...]}
    Fallback for a single turn:
      {"message": "hello"}
    """
    messages = data.get("messages")
    if messages and isinstance(messages, list):
        contents = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = (msg.get("role") or "user").lower()
            gemini_role = "model" if role in ("assistant", "model", "bot") else "user"
            text = msg.get("content") or msg.get("text") or ""
            if str(text).strip():
                contents.append({
                    "role": gemini_role,
                    "parts": [{"text": str(text)}],
                })
        if contents:
            return contents

    if data.get("message"):
        return [{"role": "user", "parts": [{"text": str(data["message"])}]}]

    return None


def _ordered_messages(session, conversation_id):
    """Stable chronological order; user before assistant when timestamps match."""
    return (
        session.query(Message)
        .filter(Message.conversation_id == conversation_id)
        .order_by(
            Message.created_at.asc(),
            case((Message.role == "user", 0), else_=1),
            Message.id.asc(),
        )
        .all()
    )


def generate_conversation_title(text):
    """Short title from the first user message — no extra Gemini call."""
    cleaned = " ".join(str(text or "").strip().split())
    cleaned = cleaned.strip(" \t?!.,;:\"'")
    if not cleaned:
        return "New conversation"
    words = cleaned.split()
    title = " ".join(words[:6])
    if len(title) > 64:
        title = title[:61].rstrip() + "…"
    return title


def _parse_uuid(value):
    try:
        return UUID(str(value))
    except (ValueError, TypeError):
        return None


def require_current_user(session):
    """Return (user, None) or (None, (response, status))."""
    user = load_user(session)
    if user is None:
        logout_user()
        return None, (jsonify({"error": "Please log in to continue."}), 401)
    return user, None


def get_owned_conversation(session, conversation_id, user):
    """Return conversation if it belongs to user; otherwise (None, status)."""
    conv_uuid = _parse_uuid(conversation_id)
    if conv_uuid is None:
        return None, 400
    conversation = session.get(Conversation, conv_uuid)
    if conversation is None or conversation.user_id != user.id:
        return None, 404
    return conversation, None


def persist_chat_turn(conversation_id, user_text, assistant_text, owner_id):
    """Save one user+assistant turn to Neon. Raises on failure."""
    session = None
    t0 = time.perf_counter()
    try:
        session = get_session()
        conversation = None
        if conversation_id:
            conv_uuid = _parse_uuid(conversation_id)
            if conv_uuid is None:
                raise ValueError("Invalid conversation id.")
            conversation = session.get(Conversation, conv_uuid)
            if conversation is not None and conversation.user_id != owner_id:
                raise LookupError("Conversation not found.")
        if conversation is None:
            conversation = Conversation(
                user_id=owner_id,
                title=generate_conversation_title(user_text),
            )
            session.add(conversation)
            session.flush()
        elif not (conversation.title or "").strip():
            conversation.title = generate_conversation_title(user_text)

        conversation.updated_at = utcnow()
        user_msg = Message(conversation_id=conversation.id, role="user", content=user_text)
        assistant_msg = Message(
            conversation_id=conversation.id, role="assistant", content=assistant_text
        )
        session.add(user_msg)
        session.add(assistant_msg)
        session.commit()
        session.refresh(conversation)
        _chat_timing("persist_chat_turn_ok", t0)
        return str(conversation.id), str(user_msg.id), str(assistant_msg.id)
    except Exception:
        if session is not None:
            session.rollback()
        raise
    finally:
        if session is not None:
            session.close()
        if SessionLocal is not None:
            SessionLocal.remove()


def persist_user_edit(conversation_id, message_id, user_text, owner_id):
    """Replace a user message and delete all following turns. No Gemini call."""
    session = None
    try:
        session = get_session()
        conv_uuid = _parse_uuid(conversation_id)
        msg_uuid = _parse_uuid(message_id)
        if conv_uuid is None or msg_uuid is None:
            raise ValueError("Invalid conversation or message id.")

        conversation = session.get(Conversation, conv_uuid)
        if conversation is None or conversation.user_id != owner_id:
            raise LookupError("Conversation not found.")

        messages = _ordered_messages(session, conversation.id)
        index = next((i for i, msg in enumerate(messages) if msg.id == msg_uuid), None)
        if index is None:
            raise LookupError("Message not found.")
        target = messages[index]
        if target.role != "user":
            raise ValueError("Only user messages can be edited.")

        target.content = user_text
        for later in messages[index + 1:]:
            session.delete(later)
        conversation.updated_at = utcnow()
        session.commit()
        return str(conversation.id), str(target.id)
    except Exception:
        if session is not None:
            session.rollback()
        raise
    finally:
        if session is not None:
            session.close()
        if SessionLocal is not None:
            SessionLocal.remove()


def persist_assistant_reply(conversation_id, assistant_text, owner_id):
    """Append an assistant message to an existing conversation."""
    session = None
    try:
        session = get_session()
        conv_uuid = _parse_uuid(conversation_id)
        if conv_uuid is None:
            raise ValueError("Invalid conversation id.")
        conversation = session.get(Conversation, conv_uuid)
        if conversation is None or conversation.user_id != owner_id:
            raise LookupError("Conversation not found.")
        assistant_msg = Message(
            conversation_id=conversation.id, role="assistant", content=assistant_text
        )
        conversation.updated_at = utcnow()
        session.add(assistant_msg)
        session.commit()
        return str(assistant_msg.id)
    except Exception:
        if session is not None:
            session.rollback()
        raise
    finally:
        if session is not None:
            session.close()
        if SessionLocal is not None:
            SessionLocal.remove()


def _gemini_headers():
    return {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY,
    }


def _gemini_payload(contents):
    return {
        "contents": contents,
        "systemInstruction": {
            "parts": [{"text": SYSTEM_INSTRUCTION}],
        },
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 140,
        },
    }


def _gemini_http_error_message(status_code, upstream):
    message = (
        (upstream.get("error") or {}).get("message")
        if isinstance(upstream, dict)
        else None
    )
    friendly = message or f"Gemini request failed (HTTP {status_code})."
    lower = friendly.lower()
    if "quota" in lower or "rate limit" in lower or status_code == 429:
        return (
            "Gemini free-tier quota khatam ho gaya hai is model ke liye. "
            ".env mein GEMINI_MODEL change karke server restart karein "
            "(try: gemini-3.5-flash or gemini-3.6-flash)."
        )
    if "no longer available" in lower:
        return (
            "Yeh Gemini model ab available nahi hai. "
            ".env mein GEMINI_MODEL update karke server restart karein."
        )
    return friendly


def call_gemini(contents, timing_started=None):
    """
    Call Gemini generateContent (non-streaming).
    Returns (text, None) on success, or (None, (response, status)) on failure.
    """
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent"
    )
    t0 = timing_started if timing_started is not None else time.perf_counter()
    _chat_timing("gemini_request_start", t0)

    try:
        resp = requests.post(
            url, headers=_gemini_headers(), json=_gemini_payload(contents), timeout=60
        )
    except requests.Timeout:
        _chat_timing("gemini_request_timeout", t0)
        return None, (jsonify({
            "error": "Gemini took too long to respond. Please try again."
        }), 504)
    except requests.RequestException:
        _chat_timing("gemini_request_network_error", t0)
        return None, (jsonify({
            "error": "Could not reach Gemini. Check your internet connection."
        }), 502)

    _chat_timing("gemini_request_end", t0, http_status=resp.status_code)

    try:
        upstream = resp.json()
    except ValueError:
        return None, (jsonify({
            "error": "Received an invalid response from Gemini."
        }), 502)

    if not resp.ok:
        return None, (jsonify({
            "error": _gemini_http_error_message(resp.status_code, upstream)
        }), 502)

    text = extract_gemini_text(upstream)
    if text:
        text = text.strip()
    if not text:
        return None, (jsonify({
            "error": "Gemini returned an empty response. Please try again."
        }), 502)
    return text, None


def iter_gemini_sse(contents, timing_started=None):
    """
    Stream Gemini tokens via streamGenerateContent?alt=sse.
    Yields ("delta", text_chunk) then ("done", full_text), or ("error", message).
    """
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:streamGenerateContent"
    )
    t0 = timing_started if timing_started is not None else time.perf_counter()
    _chat_timing("gemini_stream_start", t0)
    first_token = True
    pieces = []

    try:
        with requests.post(
            url,
            headers=_gemini_headers(),
            params={"alt": "sse"},
            json=_gemini_payload(contents),
            timeout=60,
            stream=True,
        ) as resp:
            if not resp.ok:
                try:
                    upstream = resp.json()
                except ValueError:
                    upstream = {}
                _chat_timing("gemini_stream_http_error", t0, http_status=resp.status_code)
                yield ("error", _gemini_http_error_message(resp.status_code, upstream))
                return

            # Force UTF-8 so emoji/multibyte text is not decoded as Latin-1.
            resp.encoding = "utf-8"
            for raw_line in resp.iter_lines(decode_unicode=True):
                if raw_line is None:
                    continue
                line = raw_line.strip()
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    chunk = json.loads(payload)
                except ValueError:
                    continue
                if isinstance(chunk, dict) and chunk.get("error"):
                    yield ("error", _gemini_http_error_message(502, chunk))
                    return
                delta = extract_gemini_text(chunk)
                if not delta:
                    continue
                if first_token:
                    _chat_timing("gemini_stream_first_token", t0)
                    first_token = False
                pieces.append(delta)
                yield ("delta", delta)
    except requests.Timeout:
        _chat_timing("gemini_stream_timeout", t0)
        yield ("error", "Gemini took too long to respond. Please try again.")
        return
    except requests.RequestException:
        _chat_timing("gemini_stream_network_error", t0)
        yield ("error", "Could not reach Gemini. Check your internet connection.")
        return

    full = "".join(pieces).strip()
    _chat_timing("gemini_stream_end", t0, chars=len(full))
    if not full:
        yield ("error", "Gemini returned an empty response. Please try again.")
        return
    yield ("done", full)


def _last_user_text(contents):
    for item in reversed(contents or []):
        if item.get("role") == "user":
            parts = item.get("parts") or []
            return (parts[0] or {}).get("text", "") if parts else ""
    return ""


def _assert_conversation_owner(conversation_id, owner_id, timing_started=None):
    """Optional ownership check. Returns (None, error_response) or (None, None)."""
    if not conversation_id:
        return None
    t0 = timing_started if timing_started is not None else time.perf_counter()
    _chat_timing("db_owner_check_start", t0)
    session = get_session()
    try:
        conv_uuid = _parse_uuid(conversation_id)
        if conv_uuid is None:
            return jsonify({"error": "Invalid conversation id."}), 400
        conversation = session.get(Conversation, conv_uuid)
        if conversation is not None and conversation.user_id != owner_id:
            return jsonify({"error": "Conversation not found."}), 404
    finally:
        session.close()
        if SessionLocal is not None:
            SessionLocal.remove()
    _chat_timing("db_owner_check_end", t0)
    return None


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/styles.css")
def styles():
    return send_from_directory(BASE_DIR, "styles.css")


@app.route("/script.js")
def script():
    return send_from_directory(BASE_DIR, "script.js")


@app.route("/config.js")
def config_js():
    return send_from_directory(BASE_DIR, "config.js")


def _db_unavailable():
    return jsonify({"error": "Database unavailable. Please try again shortly."}), 503


def _auth_service_unavailable():
    return jsonify({"error": "Database/authentication service error"}), 500


def _auth_hash_unavailable():
    return jsonify({"error": "Authentication service error"}), 500


def _tf(value):
    return "true" if value else "false"


def _read_auth_payload():
    data = request.get_json(silent=True, force=True)
    if not isinstance(data, dict):
        data = {}
    if not (data.get("email") and data.get("password")) and request.form:
        form = request.form.to_dict()
        data = {**form, **data}
    return data


def _log_login_debug(email_received, normalized_email, user_found, password_verification_result):
    app.logger.info(
        "LOGIN DEBUG\nemail_received: %s\nnormalized_email: %s\nuser_found: %s\npassword_verification_result: %s",
        _tf(email_received),
        _tf(normalized_email),
        _tf(user_found),
        _tf(password_verification_result),
    )


@app.route("/api/auth/signup", methods=["POST"])
def signup():
    """Create an account with email and password, then start a session.
    ---
    tags:
      - Auth
    summary: Sign up
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [name, email, password, confirm_password]
          properties:
            name:
              type: string
            email:
              type: string
            password:
              type: string
            confirm_password:
              type: string
    produces:
      - application/json
    responses:
      201:
        description: Account created and session started.
      400:
        description: Invalid signup data.
      409:
        description: Email already registered.
    """
    data = _read_auth_payload()
    parsed, error = validate_signup(
        data.get("name"),
        data.get("email"),
        data.get("password"),
        data.get("confirm_password") if "confirm_password" in data else data.get("confirmPassword"),
    )
    if error:
        return jsonify({"error": error}), 400

    try:
        password_hash = hash_password(parsed["password"])
    except Exception:
        app.logger.exception("Signup password hashing failed")
        return _auth_hash_unavailable()

    session = get_session()
    try:
        existing = (
            session.query(User)
            .filter(
                or_(
                    User.email == parsed["email"],
                    func.lower(func.trim(User.email)) == parsed["email"],
                )
            )
            .one_or_none()
        )
        if existing is not None:
            return jsonify({"error": "An account with this email already exists."}), 409

        user = User(
            name=parsed["name"],
            email=parsed["email"],
            password_hash=password_hash,
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        login_user(user)
        return jsonify({"ok": True, "user": public_user(user)}), 201
    except IntegrityError:
        session.rollback()
        return jsonify({"error": "An account with this email already exists."}), 409
    except SQLAlchemyError:
        session.rollback()
        app.logger.exception("Signup database error")
        return _auth_service_unavailable()
    except Exception:
        session.rollback()
        app.logger.exception("Signup failed")
        return jsonify({"error": "Could not create your account. Please try again."}), 500
    finally:
        try:
            session.close()
        except Exception:
            pass
        if SessionLocal is not None:
            SessionLocal.remove()


@app.route("/api/auth/login", methods=["POST"])
def login():
    """Log in with email and password.
    ---
    tags:
      - Auth
    summary: Log in
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [email, password]
          properties:
            email:
              type: string
            password:
              type: string
    produces:
      - application/json
    responses:
      200:
        description: Session started.
      400:
        description: Invalid login data.
      401:
        description: Incorrect email or password, or Google-only account.
    """
    data = _read_auth_payload()
    raw_email = data.get("email")
    email_received = bool(str(raw_email).strip()) if raw_email is not None else False
    parsed, error = validate_login(raw_email, data.get("password"))
    if error:
        _log_login_debug(
            email_received,
            bool(email_received and normalize_email(raw_email) == (raw_email or "").strip().lower()),
            False,
            False,
        )
        return jsonify({"error": error}), 400

    session = get_session()
    try:
        user = (
            session.query(User)
            .filter(
                or_(
                    User.email == parsed["email"],
                    func.lower(func.trim(User.email)) == parsed["email"],
                )
            )
            .one_or_none()
        )
        user_found = user is not None and bool(user.password_hash)
        if user is None or not user.password_hash:
            _log_login_debug(True, True, user is not None, False)
            return jsonify({"error": "Invalid email or password."}), 401

        stored_hash = str(user.password_hash)
        session.expunge(user)

        try:
            verify_ok = verify_password(stored_hash, parsed["password"])
        except Exception:
            app.logger.exception("Login password verification failed")
            _log_login_debug(True, True, True, False)
            return _auth_hash_unavailable()

        _log_login_debug(True, True, True, verify_ok)
        if not verify_ok:
            return jsonify({"error": "Invalid email or password."}), 401
        login_user(user)
        return jsonify({"ok": True, "user": public_user(user)})
    except SQLAlchemyError:
        app.logger.exception("Login database error")
        return _auth_service_unavailable()
    except Exception:
        app.logger.exception("Login failed")
        return jsonify({"error": "Authentication service error"}), 500
    finally:
        try:
            session.close()
        except Exception:
            pass
        if SessionLocal is not None:
            SessionLocal.remove()


@app.route("/auth/google", methods=["GET"])
def google_login_start():
    """Start Google OAuth sign-in.
    ---
    tags:
      - Auth
    summary: Continue with Google
    responses:
      302:
        description: Redirects to Google or back to the login page on error.
    """
    config, config_error = _load_google_oauth_config()
    if config_error:
        return oauth_error_redirect(config_error)
    if config is None:
        return oauth_error_redirect(google_unconfigured_message(app.debug))
    if _ensure_google_oauth() is None:
        return oauth_error_redirect(google_unconfigured_message(app.debug))
    try:
        # Always use the env redirect URI — never request.host_url / LAN IP / localhost.
        app.logger.info(
            "Google OAuth authorize_redirect redirect_uri=%s",
            config["redirect_uri"],
        )
        # prompt=select_account shows Google's account chooser for signed-in browser sessions.
        # Do not use prompt=login (that forces re-authentication).
        return oauth.google.authorize_redirect(
            redirect_uri=config["redirect_uri"],
            prompt="select_account",
        )
    except Exception:
        app.logger.exception("Google OAuth start failed")
        return oauth_error_redirect("Could not start Google sign-in. Please try again.")


@app.route("/auth/google/callback", methods=["GET"])
def google_login_callback():
    """Complete Google OAuth sign-in.
    ---
    tags:
      - Auth
    summary: Google OAuth callback
    parameters:
      - in: query
        name: code
        type: string
      - in: query
        name: state
        type: string
      - in: query
        name: error
        type: string
    responses:
      302:
        description: Redirects to the app after login, or to the login page on error.
    """
    google_error = request.args.get("error")
    if google_error == "access_denied":
        return oauth_error_redirect("Google sign-in was cancelled.")
    if google_error:
        return oauth_error_redirect("Google sign-in was not completed.")

    config, config_error = _load_google_oauth_config()
    if config_error:
        return oauth_error_redirect(config_error)
    if config is None or _ensure_google_oauth() is None:
        return oauth_error_redirect(google_unconfigured_message(app.debug))

    db_ok, _ = ping_database()
    if not db_ok:
        return oauth_error_redirect("Database unavailable. Please try again shortly.")

    try:
        # Authlib already stores redirect_uri from authorize_redirect / client registration.
        # Do NOT pass redirect_uri= again — that raises:
        # TypeError: fetch_access_token() got multiple values for keyword argument 'redirect_uri'
        app.logger.info(
            "Google OAuth token exchange redirect_uri=%s",
            config["redirect_uri"],
        )
        token = oauth.google.authorize_access_token()
    except MismatchingStateError:
        app.logger.warning("Google OAuth callback state mismatch")
        return oauth_error_redirect("Sign-in could not be verified. Please try again.")
    except OAuthError as exc:
        app.logger.exception(
            "Google OAuth token exchange OAuthError: %s",
            type(exc).__name__,
        )
        return oauth_error_redirect("Google sign-in was not completed. Please try again.")
    except TypeError as exc:
        app.logger.exception(
            "Google OAuth token exchange TypeError: %s",
            type(exc).__name__,
        )
        return oauth_error_redirect("Could not complete Google sign-in. Please try again.")
    except Exception as exc:
        app.logger.exception(
            "Google OAuth token exchange failed: %s",
            type(exc).__name__,
        )
        return oauth_error_redirect("Could not complete Google sign-in. Please try again.")

    userinfo = (token or {}).get("userinfo")
    if not userinfo:
        try:
            resp = oauth.google.get("userinfo")
            userinfo = resp.json() if resp is not None else None
        except Exception:
            app.logger.exception("Google OAuth userinfo request failed")
            userinfo = None

    if not userinfo:
        app.logger.error("Google OAuth callback missing userinfo after token exchange")
        return oauth_error_redirect("Google did not return a user profile.")

    session = get_session()
    try:
        profile = google_profile_from_userinfo(userinfo)
        user = upsert_google_user(session, profile)
        login_user(user)
        app.logger.info(
            "Google OAuth login succeeded for local user id=%s",
            str(user.id),
        )
        return frontend_redirect("/")
    except ValueError as exc:
        app.logger.warning("Google OAuth profile validation failed: %s", str(exc))
        return oauth_error_redirect(str(exc))
    except IntegrityError:
        session.rollback()
        app.logger.exception("Google OAuth user upsert IntegrityError")
        return oauth_error_redirect("Could not create your account. Please try again.")
    except Exception as exc:
        session.rollback()
        app.logger.exception(
            "Google OAuth callback failed after token exchange: %s",
            type(exc).__name__,
        )
        return oauth_error_redirect("Could not complete Google sign-in. Please try again.")
    finally:
        try:
            session.close()
        except Exception:
            pass
        if SessionLocal is not None:
            SessionLocal.remove()


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    """End the current session.
    ---
    tags:
      - Auth
    summary: Log out
    produces:
      - application/json
    responses:
      200:
        description: Session cleared.
    """
    logout_user()
    return jsonify({"ok": True})


@app.route("/api/auth/me", methods=["GET"])
def auth_me():
    """Return the current session user, if any.
    ---
    tags:
      - Auth
    summary: Current user
    produces:
      - application/json
    responses:
      200:
        description: Authentication status.
    """
    db_ok, _ = ping_database()
    if not db_ok:
        return jsonify({"authenticated": False, "user": None})

    session = get_session()
    try:
        user = load_user(session)
        if user is None:
            return jsonify({"authenticated": False, "user": None})
        return jsonify({"authenticated": True, "user": public_user(user)})
    finally:
        session.close()
        if SessionLocal is not None:
            SessionLocal.remove()


@app.route("/api/health", methods=["GET"])
def health():
    """Service and database health.
    ---
    tags:
      - System
    summary: Health check
    description: Reports whether the API and PostgreSQL connection are available. Does not return secrets.
    produces:
      - application/json
    responses:
      200:
        description: Service is up and the database is reachable.
        examples:
          application/json:
            ok: true
            service: NovaChat AI
            database: connected
            tts: configured
            detail: connected
      503:
        description: Service is up but the database is unavailable.
        examples:
          application/json:
            ok: false
            service: NovaChat AI
            database: unavailable
            tts: unconfigured
            detail: Database unavailable.
    """
    db_ok, db_detail = ping_database()
    status = 200 if db_ok else 503
    return jsonify({
        "ok": db_ok,
        "service": "NovaChat AI",
        "database": "connected" if db_ok else "unavailable",
        "tts": "configured" if tts_configured() else "unconfigured",
        "detail": db_detail,
    }), status


def _preview_from_messages(messages):
    for msg in messages:
        if msg.role == "user" and (msg.content or "").strip():
            preview = " ".join(msg.content.strip().split())
            return preview[:56] + ("…" if len(preview) > 56 else "")
    return "New conversation"


@app.route("/api/conversations", methods=["GET"])
@login_required
def list_conversations():
    """List saved conversations for the logged-in user.
    ---
    tags:
      - Conversations
    summary: List conversations
    description: >
      Returns the current user's conversations newest-first.
      Optional q searches title and message content.
    parameters:
      - in: query
        name: q
        type: string
        required: false
        description: Search text matched against titles and message content.
    produces:
      - application/json
    responses:
      200:
        description: Conversation list.
      401:
        description: Not logged in.
      503:
        description: Database is unavailable.
    """
    db_ok, _ = ping_database()
    if not db_ok:
        return _db_unavailable()

    raw_query = str(request.args.get("q") or "").strip()
    search = raw_query[:80] if raw_query else ""

    session = get_session()
    try:
        user, auth_error = require_current_user(session)
        if auth_error:
            return auth_error

        query = session.query(Conversation).filter(Conversation.user_id == user.id)
        if search:
            pattern = f"%{search}%"
            matching_ids = (
                session.query(Conversation.id)
                .outerjoin(Message, Message.conversation_id == Conversation.id)
                .filter(Conversation.user_id == user.id)
                .filter(or_(
                    Conversation.title.ilike(pattern),
                    Message.content.ilike(pattern),
                ))
                .distinct()
            )
            query = session.query(Conversation).filter(Conversation.id.in_(matching_ids))
        conversations = (
            query.order_by(
                Conversation.updated_at.desc().nullslast(),
                Conversation.created_at.desc(),
            )
            .limit(100)
            .all()
        )
        items = []
        for conv in conversations:
            title = (conv.title or "").strip() or _preview_from_messages(conv.messages)
            items.append({
                "id": str(conv.id),
                "title": title,
                "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
                "created_at": conv.created_at.isoformat() if conv.created_at else None,
            })
        return jsonify({"conversations": items, "query": search or None})
    except Exception:
        app.logger.exception("List conversations failed")
        return jsonify({"error": "Could not load chat history."}), 500
    finally:
        session.close()
        if SessionLocal is not None:
            SessionLocal.remove()


@app.route("/api/conversations/<conversation_id>", methods=["DELETE"])
@login_required
def delete_conversation(conversation_id):
    """Delete one conversation and its messages.
    ---
    tags:
      - Conversations
    summary: Delete a conversation
    parameters:
      - in: path
        name: conversation_id
        type: string
        format: uuid
        required: true
        description: Conversation identifier.
    produces:
      - application/json
    responses:
      200:
        description: Conversation deleted.
      400:
        description: Invalid conversation id.
      401:
        description: Not logged in.
      404:
        description: Conversation not found.
      503:
        description: Database is unavailable.
    """
    db_ok, _ = ping_database()
    if not db_ok:
        return _db_unavailable()

    session = get_session()
    try:
        user, auth_error = require_current_user(session)
        if auth_error:
            return auth_error
        conversation, status = get_owned_conversation(session, conversation_id, user)
        if conversation is None:
            message = "Invalid conversation id." if status == 400 else "Conversation not found."
            return jsonify({"error": message}), status
        deleted_id = str(conversation.id)
        session.delete(conversation)
        session.commit()
        return jsonify({"ok": True, "deleted": deleted_id})
    except Exception:
        session.rollback()
        app.logger.exception("Delete conversation failed")
        return jsonify({"error": "Could not delete that conversation."}), 500
    finally:
        session.close()
        if SessionLocal is not None:
            SessionLocal.remove()


@app.route("/api/conversations/<conversation_id>/messages", methods=["GET"])
@login_required
def list_conversation_messages(conversation_id):
    """Load messages for a conversation.
    ---
    tags:
      - Conversations
    summary: List conversation messages
    parameters:
      - in: path
        name: conversation_id
        type: string
        format: uuid
        required: true
        description: Conversation identifier.
    produces:
      - application/json
    responses:
      200:
        description: Messages in chronological order.
      400:
        description: Invalid conversation id.
      401:
        description: Not logged in.
      404:
        description: Conversation not found.
      503:
        description: Database is unavailable.
    """
    db_ok, _ = ping_database()
    if not db_ok:
        return _db_unavailable()

    session = get_session()
    try:
        user, auth_error = require_current_user(session)
        if auth_error:
            return auth_error
        conversation, status = get_owned_conversation(session, conversation_id, user)
        if conversation is None:
            message = "Invalid conversation id." if status == 400 else "Conversation not found."
            return jsonify({"error": message}), status
        messages = [
            {
                "id": str(msg.id),
                "role": msg.role,
                "content": msg.content,
                "created_at": msg.created_at.isoformat() if msg.created_at else None,
            }
            for msg in _ordered_messages(session, conversation.id)
        ]
        return jsonify({
            "conversation_id": str(conversation.id),
            "title": (conversation.title or "").strip() or _preview_from_messages(conversation.messages),
            "messages": messages,
        })
    except Exception:
        app.logger.exception("List conversation messages failed")
        return jsonify({"error": "Could not open that conversation."}), 500
    finally:
        session.close()
        if SessionLocal is not None:
            SessionLocal.remove()


@app.route("/api/chat", methods=["GET"])
def chat_info():
    """Describe chat-related endpoints.
    ---
    tags:
      - Chat
    summary: Chat API usage hints
    produces:
      - application/json
    responses:
      200:
        description: How to call chat, edit, and TTS.
        examples:
          application/json:
            endpoint: /api/chat
            method: POST
            body:
              messages:
                - role: user
                  content: What is Python?
            ui: /
            edit:
              endpoint: /api/messages/edit
              method: POST
            tts:
              endpoint: /api/tts
              method: POST
    """
    return jsonify({
        "endpoint": "/api/chat",
        "method": "POST",
        "body": {
            "messages": [
                {"role": "user", "content": "What is Python?"},
                {"role": "assistant", "content": "..."},
                {"role": "user", "content": "Who created it?"},
            ]
        },
        "ui": "/",
        "edit": {
            "endpoint": "/api/messages/edit",
            "method": "POST",
            "body": {
                "conversation_id": "uuid",
                "message_id": "uuid",
                "content": "Edited user message",
            },
        },
        "tts": {
            "endpoint": "/api/tts",
            "method": "POST",
            "body": {"text": "Hello, how can I help you today?"},
        },
    })


@app.route("/api/chat", methods=["POST"])
@login_required
def chat():
    """Send a message and receive an assistant reply.
    ---
    tags:
      - Chat
    summary: Generate a chat reply
    description: >
      Accepts the full in-memory conversation so far. Optional conversation_id
      continues a saved thread. Server-side credentials are never returned.
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          properties:
            conversation_id:
              type: string
              format: uuid
              description: Existing conversation to append to. Omit to start a new one.
            messages:
              type: array
              items:
                type: object
                properties:
                  role:
                    type: string
                    enum: [user, assistant]
                  content:
                    type: string
            message:
              type: string
              description: Single-turn fallback if messages is omitted.
          example:
            conversation_id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
            messages:
              - role: user
                content: What is Python?
              - role: assistant
                content: Python is a programming language.
              - role: user
                content: Who created it?
    produces:
      - application/json
    responses:
      200:
        description: Assistant reply. Persistence ids are included when save succeeds.
        examples:
          application/json:
            reply: Python was created by Guido van Rossum.
            conversation_id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
            user_message_id: 7c9e6679-7425-40de-944b-e07fc1f90ae7
            assistant_message_id: 0c1a2b3d-4e5f-6789-abcd-ef0123456789
      400:
        description: Missing or empty message.
        examples:
          application/json:
            error: Request must include a non-empty message.
      500:
        description: Chat generation is not configured on the server.
        examples:
          application/json:
            error: Server is not configured to generate replies.
      502:
        description: Upstream generation failed.
        examples:
          application/json:
            error: Could not reach Gemini. Check your internet connection.
      504:
        description: Upstream generation timed out.
        examples:
          application/json:
            error: Gemini took too long to respond. Please try again.
    """
    t0 = time.perf_counter()
    _chat_timing("flask_request_received", t0)

    if not API_KEY:
        return jsonify({
            "error": "Server is missing GEMINI_API_KEY. Copy .env.example to .env and add your key."
        }), 500

    data = request.get_json(silent=True) or {}
    contents = build_contents(data)
    if not contents:
        return jsonify({"error": "Request must include a non-empty message."}), 400

    owner_id = session_owner_id()
    if owner_id is None:
        logout_user()
        return jsonify({"error": "Please log in to continue."}), 401

    owner_error = _assert_conversation_owner(
        data.get("conversation_id"), owner_id, timing_started=t0
    )
    if owner_error:
        return owner_error

    text, gemini_error = call_gemini(contents, timing_started=t0)
    if gemini_error:
        return gemini_error

    payload_out = {"reply": text}
    last_user = _last_user_text(contents)

    if last_user:
        try:
            _chat_timing("db_save_start", t0)
            saved_id, user_message_id, assistant_message_id = persist_chat_turn(
                data.get("conversation_id"), last_user, text, owner_id
            )
            _chat_timing("db_save_end", t0)
            payload_out["conversation_id"] = saved_id
            payload_out["user_message_id"] = user_message_id
            payload_out["assistant_message_id"] = assistant_message_id
        except LookupError as exc:
            return jsonify({"error": str(exc)}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except RuntimeError as exc:
            app.logger.warning("Chat persist skipped: %s", exc)
        except Exception as exc:
            app.logger.exception("Chat persist failed: %s", exc)

    _chat_timing("response_sent", t0)
    return jsonify(payload_out)


@app.route("/api/chat/stream", methods=["POST"])
@login_required
def chat_stream():
    """Stream an assistant reply as NDJSON (delta tokens, then done/error)."""
    t0 = time.perf_counter()
    _chat_timing("01_flask_received", t0, model=GEMINI_MODEL, path="/api/chat/stream")

    if not API_KEY:
        return jsonify({
            "error": "Server is missing GEMINI_API_KEY. Copy .env.example to .env and add your key."
        }), 500

    data = request.get_json(silent=True) or {}
    contents = build_contents(data)
    if not contents:
        return jsonify({"error": "Request must include a non-empty message."}), 400

    _chat_timing("02_auth_session_start", t0)
    owner_id = session_owner_id()
    if owner_id is None:
        logout_user()
        return jsonify({"error": "Please log in to continue."}), 401
    _chat_timing(
        "03_auth_session_end",
        t0,
        owner_ok=1,
        history_source="client_messages",
        message_count=len(contents),
        note="no_db_history_load_on_chat",
    )

    owner_error = _assert_conversation_owner(
        data.get("conversation_id"), owner_id, timing_started=t0
    )
    if owner_error:
        return owner_error
    _chat_timing(
        "04_conversation_owner_check_done",
        t0,
        had_conversation_id=1 if data.get("conversation_id") else 0,
    )

    conversation_id = data.get("conversation_id")
    last_user = _last_user_text(contents)

    @stream_with_context
    def generate():
        full_text = ""
        delta_count = 0
        gemini_first_ms = None
        gemini_end_ms = None
        for kind, value in iter_gemini_sse(contents, timing_started=t0):
            if kind == "delta":
                delta_count += 1
                if delta_count == 1:
                    gemini_first_ms = _perf_ms(t0)
                    _chat_timing("06_gemini_first_token", t0, delta_chars=len(value))
                yield json.dumps({"type": "delta", "text": value}, ensure_ascii=False) + "\n"
            elif kind == "error":
                yield json.dumps({"type": "error", "error": value}, ensure_ascii=False) + "\n"
                return
            elif kind == "done":
                full_text = value
                gemini_end_ms = _perf_ms(t0)
                _chat_timing(
                    "07_gemini_complete",
                    t0,
                    chars=len(full_text),
                    delta_events=delta_count,
                )

        payload = {"type": "done", "reply": full_text}
        db_ms = 0
        if last_user and full_text:
            try:
                db_t0 = time.perf_counter()
                _chat_timing("08_db_save_start", t0)
                saved_id, user_message_id, assistant_message_id = persist_chat_turn(
                    conversation_id, last_user, full_text, owner_id
                )
                db_ms = _perf_ms(db_t0)
                _chat_timing("09_db_save_end", t0, db_only_ms=db_ms)
                payload["conversation_id"] = saved_id
                payload["user_message_id"] = user_message_id
                payload["assistant_message_id"] = assistant_message_id
            except LookupError as exc:
                yield json.dumps({"type": "error", "error": str(exc)}, ensure_ascii=False) + "\n"
                return
            except ValueError as exc:
                yield json.dumps({"type": "error", "error": str(exc)}, ensure_ascii=False) + "\n"
                return
            except RuntimeError as exc:
                app.logger.warning("Chat stream persist skipped: %s", exc)
            except Exception as exc:
                app.logger.exception("Chat stream persist failed: %s", exc)

        after_gemini_ms = _perf_ms(t0) - (gemini_end_ms or _perf_ms(t0))
        _chat_timing(
            "10_flask_stream_complete",
            t0,
            gemini_first_ms=gemini_first_ms,
            gemini_end_ms=gemini_end_ms,
            db_only_ms=db_ms,
            after_gemini_ms=after_gemini_ms,
            delta_events=delta_count,
        )
        yield json.dumps(payload, ensure_ascii=False) + "\n"

    _chat_timing("05_gemini_request_about_to_start", t0)
    return Response(
        generate(),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/messages/edit", methods=["POST"])
@login_required
def edit_message():
    """Edit a user message and regenerate the assistant reply.
    ---
    tags:
      - Chat
    summary: Edit a user message
    description: >
      Updates the selected user message, removes later turns, then generates a
      new assistant reply. The displayed chat history is rebuilt from the
      saved conversation.
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required:
            - conversation_id
            - message_id
            - content
          properties:
            conversation_id:
              type: string
              format: uuid
            message_id:
              type: string
              format: uuid
              description: Id of the user message to replace.
            content:
              type: string
              description: New user text.
          example:
            conversation_id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
            message_id: 7c9e6679-7425-40de-944b-e07fc1f90ae7
            content: Explain REST API in simple Hindi
    produces:
      - application/json
    responses:
      200:
        description: Edited user message and new assistant reply.
        examples:
          application/json:
            reply: REST API ek tarika hai jisse apps HTTP par baat karti hain.
            edited: true
            conversation_id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
            user_message_id: 7c9e6679-7425-40de-944b-e07fc1f90ae7
            assistant_message_id: 1a2b3c4d-5e6f-7890-abcd-ef1234567890
      400:
        description: Invalid or empty edit.
        examples:
          application/json:
            error: Edited message cannot be empty.
      404:
        description: Conversation or message not found.
        examples:
          application/json:
            error: Message not found.
      500:
        description: Chat generation is not configured, or the edit could not be saved.
        examples:
          application/json:
            error: Could not save the edited message. Please try again.
      502:
        description: Generation failed after the edit was saved.
        examples:
          application/json:
            error: Could not reach Gemini. Check your internet connection.
            edited: true
            conversation_id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
            user_message_id: 7c9e6679-7425-40de-944b-e07fc1f90ae7
      503:
        description: Database unavailable.
        examples:
          application/json:
            error: Database unavailable.
      504:
        description: Generation timed out after the edit was saved.
        examples:
          application/json:
            error: Gemini took too long to respond. Please try again.
            edited: true
    """
    if not API_KEY:
        return jsonify({
            "error": "Server is missing GEMINI_API_KEY. Copy .env.example to .env and add your key."
        }), 500

    data = request.get_json(silent=True) or {}
    conversation_id = data.get("conversation_id")
    message_id = data.get("message_id")
    content = str(data.get("content") or "").strip()

    if not conversation_id or not message_id:
        return jsonify({"error": "conversation_id and message_id are required."}), 400
    if not content:
        return jsonify({"error": "Edited message cannot be empty."}), 400
    if len(content) > MESSAGE_MAX_CHARS:
        return jsonify({"error": "Edited message is too long. Please shorten it a bit."}), 400

    owner_id = session_owner_id()
    if owner_id is None:
        logout_user()
        return jsonify({"error": "Please log in to continue."}), 401

    try:
        saved_conversation_id, saved_message_id = persist_user_edit(
            conversation_id, message_id, content, owner_id
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503
    except Exception as exc:
        app.logger.exception("Message edit persist failed: %s", exc)
        return jsonify({"error": "Could not save the edited message. Please try again."}), 500

    session = None
    try:
        session = get_session()
        remaining = _ordered_messages(session, _parse_uuid(saved_conversation_id))
        history = [
            {"role": msg.role, "content": msg.content}
            for msg in remaining
            if (msg.content or "").strip()
        ]
    finally:
        if session is not None:
            session.close()
        if SessionLocal is not None:
            SessionLocal.remove()

    contents = build_contents({"messages": history})
    if not contents:
        return jsonify({
            "error": "Edited message cannot be empty.",
            "edited": True,
            "conversation_id": saved_conversation_id,
            "user_message_id": saved_message_id,
        }), 400

    text, gemini_error = call_gemini(contents)
    if gemini_error:
        error_response, status = gemini_error
        payload = error_response.get_json(silent=True) or {}
        payload["edited"] = True
        payload["conversation_id"] = saved_conversation_id
        payload["user_message_id"] = saved_message_id
        return jsonify(payload), status

    assistant_message_id = None
    try:
        assistant_message_id = persist_assistant_reply(saved_conversation_id, text, owner_id)
    except RuntimeError as exc:
        app.logger.warning("Edit assistant persist skipped: %s", exc)
    except Exception as exc:
        app.logger.exception("Edit assistant persist failed: %s", exc)

    return jsonify({
        "reply": text,
        "edited": True,
        "conversation_id": saved_conversation_id,
        "user_message_id": saved_message_id,
        "assistant_message_id": assistant_message_id,
    })


@app.route("/api/tts", methods=["POST"])
@login_required
def text_to_speech():
    """Convert assistant text to speech audio.
    ---
    tags:
      - Voice
    summary: Generate speech audio
    description: >
      Cleans Markdown for speech and returns MP3 audio. Provider credentials
      stay on the server and are never returned.
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [text]
          properties:
            text:
              type: string
              description: Raw assistant text (Markdown is cleaned for speech only).
          example:
            text: "### REST API\n\n**REST API** allows applications to communicate over HTTP."
    produces:
      - audio/mpeg
      - application/json
    responses:
      200:
        description: MP3 audio for the cleaned speech text.
        examples:
          audio/mpeg: (binary MP3)
      400:
        description: Missing or empty text.
        examples:
          application/json:
            error: Request must include text to speak.
      502:
        description: Voice generation failed. Chat still works.
        examples:
          application/json:
            error: Could not generate voice audio. Chat still works.
      503:
        description: Voice is not configured on the server.
        examples:
          application/json:
            error: Voice is not configured yet.
    """
    data = request.get_json(silent=True) or {}
    text = data.get("text")
    if text is None or not str(text).strip():
        return jsonify({"error": "Request must include text to speak."}), 400

    try:
        audio, content_type = synthesize_speech(text)
    except ValueError:
        return jsonify({"error": "Nothing to speak in that message."}), 400
    except TtsConfigError:
        return jsonify({
            "error": "Voice is not configured yet. Add TTS_API_KEY on the server."
        }), 503
    except TtsError as exc:
        return jsonify({"error": str(exc)}), 502
    except Exception:
        app.logger.exception("TTS failed")
        return jsonify({"error": "Could not generate voice audio. Chat still works."}), 502

    return Response(audio, mimetype=content_type, headers={
        "Cache-Control": "no-store",
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002, debug=True)
