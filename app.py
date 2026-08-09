"""
Flask backend for the Chatbox UI.
- Serves the existing index.html / styles.css / script.js
- Proxies chat to Google Gemini (API key stays server-side)
"""
import os

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

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
CORS(app)


def extract_gemini_text(resp_json):
    """Pull plain text out of a Gemini generateContent response."""
    try:
        candidates = resp_json.get("candidates") or []
        if not candidates:
            return None
        content = candidates[0].get("content") or {}
        parts = content.get("parts") or []
        texts = [p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text")]
        return "\n".join(texts).strip() if texts else None
    except (AttributeError, IndexError, KeyError, TypeError):
        return None


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
        return contents or None

    if data.get("message"):
        return [{"role": "user", "parts": [{"text": str(data["message"])}]}]

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


@app.route("/api/chat", methods=["GET"])
def chat_info():
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
    })


@app.route("/api/chat", methods=["POST"])
def chat():
    if not API_KEY:
        return jsonify({
            "error": "Server is missing GEMINI_API_KEY. Copy .env.example to .env and add your key."
        }), 500

    data = request.get_json(silent=True) or {}
    contents = build_contents(data)
    if not contents:
        return jsonify({"error": "Request must include a non-empty message."}), 400

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent"
    )
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY,
    }
    payload = {
        "contents": contents,
        "systemInstruction": {
            "parts": [{"text": SYSTEM_INSTRUCTION}],
        },
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 140,
        },
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=60)
    except requests.Timeout:
        return jsonify({"error": "Gemini took too long to respond. Please try again."}), 504
    except requests.RequestException:
        return jsonify({"error": "Could not reach Gemini. Check your internet connection."}), 502

    try:
        upstream = resp.json()
    except ValueError:
        return jsonify({"error": "Received an invalid response from Gemini."}), 502

    if not resp.ok:
        message = (
            (upstream.get("error") or {}).get("message")
            if isinstance(upstream, dict)
            else None
        )
        friendly = message or f"Gemini request failed (HTTP {resp.status_code})."
        lower = friendly.lower()
        if "quota" in lower or "rate limit" in lower or resp.status_code == 429:
            friendly = (
                "Gemini free-tier quota khatam ho gaya hai is model ke liye. "
                ".env mein GEMINI_MODEL change karke server restart karein "
                "(try: gemini-3.5-flash or gemini-3.6-flash)."
            )
        elif "no longer available" in lower:
            friendly = (
                "Yeh Gemini model ab available nahi hai. "
                ".env mein GEMINI_MODEL update karke server restart karein."
            )
        return jsonify({"error": friendly}), 502

    text = extract_gemini_text(upstream)
    if not text:
        return jsonify({"error": "Gemini returned an empty response. Please try again."}), 502

    return jsonify({"reply": text})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002, debug=True)
