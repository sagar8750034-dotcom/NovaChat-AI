"""Isolated neural TTS client. Keys stay on the server; swap this module to change providers."""
import hashlib
import os
import re
from collections import OrderedDict

import requests

TTS_MAX_CHARS = 4000
_CACHE_LIMIT = 24
_audio_cache = OrderedDict()

# Premade ElevenLabs male voice: Daniel — calm, clear, professional British adult male.
DEFAULT_VOICE_ID = "onwK4e9ZLuTAKqWW03F9"
DEFAULT_MODEL = "eleven_multilingual_v2"


class TtsConfigError(RuntimeError):
    """TTS is not configured (missing API key)."""


class TtsError(RuntimeError):
    """TTS provider call failed. Message is safe to show to users."""


def tts_configured():
    return bool((os.getenv("TTS_API_KEY") or "").strip())


def clean_text_for_speech(raw):
    """Clean Markdown for speech only. Does not change displayed chat text."""
    text = str(raw or "")
    if not text.strip():
        return ""

    text = re.sub(r"```[\s\S]*?```", ". ", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\bhttps?://\S+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bwww\.\S+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s{0,3}>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*([-*_])\1{2,}\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"(\*\*|__)([\s\S]*?)\1", r"\2", text)
    text = re.sub(r"(\*|_)([^*\n]+)\1", r"\2", text)
    text = re.sub(r"~~([^~]+)~~", r"\1", text)
    text = re.sub(r"^\s*[-*+]\s+", ". ", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+[.)]\s+", ". ", text, flags=re.MULTILINE)
    text = re.sub(r"[*_~]+", " ", text)
    text = re.sub(r"\n+", ". ", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s*([,;:!?])\s*", r"\1 ", text)
    text = re.sub(r"([.!?])\s*\.", r"\1", text)
    text = re.sub(r"\s+\.", ".", text)
    text = re.sub(r"\.{2,}", ".", text)
    return re.sub(r"\s+", " ", text).strip()


def _cache_key(voice_id, model, text):
    digest = hashlib.sha256(f"{voice_id}|{model}|{text}".encode("utf-8")).hexdigest()
    return digest


def _cache_get(key):
    audio = _audio_cache.get(key)
    if audio is None:
        return None
    _audio_cache.move_to_end(key)
    return audio


def _cache_put(key, audio):
    _audio_cache[key] = audio
    _audio_cache.move_to_end(key)
    while len(_audio_cache) > _CACHE_LIMIT:
        _audio_cache.popitem(last=False)


def synthesize_speech(text):
    """
    Turn cleaned speech text into MP3 bytes.
    Returns (audio_bytes, content_type).
    """
    api_key = (os.getenv("TTS_API_KEY") or "").strip()
    if not api_key:
        raise TtsConfigError("Voice is not configured on the server.")

    speech = clean_text_for_speech(text)
    if not speech:
        raise ValueError("Nothing to speak.")
    if len(speech) > TTS_MAX_CHARS:
        speech = speech[:TTS_MAX_CHARS].rsplit(" ", 1)[0] + "."

    voice_id = (os.getenv("TTS_VOICE_ID") or DEFAULT_VOICE_ID).strip() or DEFAULT_VOICE_ID
    model_id = (os.getenv("TTS_MODEL") or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    cache_key = _cache_key(voice_id, model_id, speech)
    cached = _cache_get(cache_key)
    if cached:
        return cached, "audio/mpeg"

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": api_key,
    }
    payload = {
        "text": speech,
        "model_id": model_id,
        "voice_settings": {
            "stability": 0.48,
            "similarity_boost": 0.75,
            "style": 0.18,
            "use_speaker_boost": True,
        },
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=60)
    except requests.Timeout as exc:
        raise TtsError("Voice took too long to respond. Please try again.") from exc
    except requests.RequestException as exc:
        raise TtsError("Voice is unavailable right now. Chat still works.") from exc

    if response.status_code == 401:
        raise TtsError("Voice service is not authorized. Check server configuration.")
    if response.status_code == 429:
        raise TtsError("Voice is busy right now. Please try again in a moment.")
    if not response.ok or not response.content:
        raise TtsError("Could not generate voice audio. Chat still works.")

    audio = response.content
    _cache_put(cache_key, audio)
    return audio, "audio/mpeg"
