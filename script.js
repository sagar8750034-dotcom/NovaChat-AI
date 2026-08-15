const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const chatWindow = document.getElementById('chatWindow');
const sendButton = document.getElementById('sendButton')
  || chatForm.querySelector('button[type="submit"]');
const micButton = document.getElementById('micButton');
const voiceStatus = document.getElementById('voiceStatus');
const welcomeSection = document.getElementById('welcomeSection');

// In-memory session history (clears on page refresh / new session)
const conversationHistory = [];
let conversationId = null;

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSupported = Boolean(SpeechRecognitionAPI);
const ttsSupported = 'speechSynthesis' in window;

let recognition = null;
let isListening = false;
let activeSpeakButton = null;
let isSending = false;

if (typeof marked !== 'undefined') {
  marked.setOptions({
    gfm: true,
    breaks: true,
  });
}

function scrollChatToBottom() {
  // Wait for layout (markdown/lists) so the full bubble height is included
  requestAnimationFrame(() => {
    chatWindow.scrollTop = chatWindow.scrollHeight;
    requestAnimationFrame(() => {
      chatWindow.scrollTop = chatWindow.scrollHeight;
      const last = chatWindow.lastElementChild;
      if (last) {
        last.scrollIntoView({ block: 'end', behavior: 'smooth' });
      }
    });
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdownSafely(markdown) {
  const source = String(markdown ?? '');

  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return escapeHtml(source);
  }

  const rawHtml = marked.parse(source);
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
  });
}

function hideWelcomeSection() {
  if (welcomeSection) {
    welcomeSection.classList.add('is-hidden');
  }
}

function setVoiceStatus(text, { listening = false } = {}) {
  if (!voiceStatus) return;
  if (!text) {
    voiceStatus.hidden = true;
    voiceStatus.textContent = '';
    voiceStatus.classList.remove('is-listening');
    return;
  }
  voiceStatus.hidden = false;
  voiceStatus.textContent = text;
  voiceStatus.classList.toggle('is-listening', listening);
}

function stopSpeaking() {
  if (ttsSupported) {
    window.speechSynthesis.cancel();
  }
  if (activeSpeakButton) {
    activeSpeakButton.classList.remove('is-speaking');
    activeSpeakButton.setAttribute('aria-label', 'Read aloud');
    activeSpeakButton.title = 'Read aloud';
    activeSpeakButton.textContent = '🔊';
    activeSpeakButton = null;
  }
}

function speakText(text, button) {
  if (!ttsSupported) {
    setVoiceStatus('Text-to-speech is not supported in this browser.');
    return;
  }

  const speakable = String(text || '').trim();
  if (!speakable) return;

  // Toggle stop if the same button is clicked while speaking
  if (activeSpeakButton === button && window.speechSynthesis.speaking) {
    stopSpeaking();
    return;
  }

  stopSpeaking();

  const utterance = new SpeechSynthesisUtterance(speakable);
  utterance.rate = 1;
  utterance.pitch = 1;

  activeSpeakButton = button;
  button.classList.add('is-speaking');
  button.setAttribute('aria-label', 'Stop speaking');
  button.title = 'Stop speaking';
  button.textContent = '⏹';

  utterance.onend = () => {
    if (activeSpeakButton === button) {
      stopSpeaking();
    }
  };
  utterance.onerror = () => {
    if (activeSpeakButton === button) {
      stopSpeaking();
    }
  };

  window.speechSynthesis.speak(utterance);
}

function createSpeakButton(speakTextValue) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'speak-button';
  button.setAttribute('aria-label', 'Read aloud');
  button.title = ttsSupported ? 'Read aloud' : 'Text-to-speech not supported';
  button.textContent = '🔊';

  if (!ttsSupported) {
    button.disabled = true;
    return button;
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    speakText(speakTextValue, button);
  });

  return button;
}

function appendMessage(text, isUser = false) {
  const message = document.createElement('div');
  message.className = `message ${isUser ? 'user-message' : 'bot-message'}`;

  if (isUser) {
    message.textContent = text;
  } else {
    const content = document.createElement('div');
    content.className = 'message-content';
    // Sanitized Markdown only — never assign raw AI HTML directly.
    content.innerHTML = renderMarkdownSafely(text);
    message.appendChild(content);

    const plainText = content.innerText || text;
    message.appendChild(createSpeakButton(plainText));
  }

  chatWindow.appendChild(message);
  scrollChatToBottom();
  return message;
}

function showTypingIndicator() {
  const indicator = document.createElement('div');
  indicator.className = 'message bot-message typing-indicator';
  indicator.id = 'typingIndicator';
  indicator.setAttribute('aria-live', 'polite');
  indicator.innerHTML =
    '<span class="thinking-label">Thinking</span>' +
    '<span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>';
  chatWindow.appendChild(indicator);
  scrollChatToBottom();
  return indicator;
}

function hideTypingIndicator() {
  const indicator = document.getElementById('typingIndicator');
  if (indicator) indicator.remove();
}

function setLoading(isLoading) {
  isSending = isLoading;
  if (sendButton) sendButton.disabled = isLoading;
  if (userInput) userInput.disabled = isLoading;
  if (micButton) {
    micButton.disabled = isLoading || !speechSupported;
  }
  document.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.disabled = isLoading;
  });
}

function stopListening({ silent = false } = {}) {
  if (recognition && isListening) {
    try {
      recognition.stop();
    } catch (_) {
      // ignore
    }
  }
  isListening = false;
  if (micButton) {
    micButton.classList.remove('is-listening');
    micButton.setAttribute('aria-pressed', 'false');
    micButton.setAttribute('aria-label', 'Voice input');
    micButton.title = 'Voice input';
  }
  if (!silent) {
    setVoiceStatus('');
  }
}

function startListening() {
  if (!speechSupported) {
    setVoiceStatus('Voice input is not supported in this browser. Try Chrome or Edge.');
    return;
  }

  if (isListening) {
    stopListening();
    return;
  }

  stopSpeaking();

  recognition = new SpeechRecognitionAPI();
  recognition.lang = 'en-IN';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    micButton.classList.add('is-listening');
    micButton.setAttribute('aria-pressed', 'true');
    micButton.setAttribute('aria-label', 'Stop recording');
    micButton.title = 'Stop recording';
    setVoiceStatus('Listening... speak now', { listening: true });
  };

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      transcript += event.results[i][0].transcript;
    }
    transcript = transcript.trim();
    if (transcript) {
      userInput.value = transcript;
    }

    const last = event.results[event.results.length - 1];
    if (last && last.isFinal) {
      setVoiceStatus('Got it — tap Send or keep editing');
    }
  };

  recognition.onerror = (event) => {
    isListening = false;
    micButton.classList.remove('is-listening');
    micButton.setAttribute('aria-pressed', 'false');
    micButton.setAttribute('aria-label', 'Voice input');
    micButton.title = 'Voice input';

    const error = event.error || 'unknown';
    if (error === 'not-allowed' || error === 'service-not-allowed') {
      setVoiceStatus('Microphone permission denied. Allow mic access and try again.');
    } else if (error === 'no-speech') {
      setVoiceStatus('No speech detected. Try again.');
    } else if (error === 'aborted') {
      setVoiceStatus('');
    } else {
      setVoiceStatus('Could not capture voice. Please try again.');
    }
  };

  recognition.onend = () => {
    isListening = false;
    micButton.classList.remove('is-listening');
    micButton.setAttribute('aria-pressed', 'false');
    micButton.setAttribute('aria-label', 'Voice input');
    micButton.title = 'Voice input';
    if (voiceStatus && voiceStatus.classList.contains('is-listening')) {
      if (userInput.value.trim()) {
        setVoiceStatus('Got it — tap Send or keep editing');
      } else {
        setVoiceStatus('');
      }
    }
  };

  try {
    recognition.start();
  } catch (_) {
    setVoiceStatus('Could not start microphone. Please try again.');
    stopListening({ silent: true });
  }
}

function setupVoiceControls() {
  if (!micButton) return;

  if (!speechSupported) {
    micButton.disabled = true;
    micButton.title = 'Voice input not supported in this browser';
    micButton.setAttribute('aria-disabled', 'true');
  } else {
    micButton.addEventListener('click', () => {
      if (isListening) {
        stopListening();
      } else {
        startListening();
      }
    });
  }
}

async function fetchGeminiResponse(messages) {
  const body = { messages };
  if (conversationId) {
    body.conversation_id = conversationId;
  }

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('Server se valid response nahi mila.');
  }

  if (!response.ok) {
    throw new Error(data.error || 'Gemini se jawab nahi mil paya. Thodi der baad try karein.');
  }

  if (!data.reply) {
    throw new Error('Gemini se response nahi mila.');
  }

  if (data.conversation_id) {
    conversationId = data.conversation_id;
  }

  return data.reply;
}

async function sendUserMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || isSending) return;

  stopListening({ silent: true });
  stopSpeaking();
  hideWelcomeSection();

  appendMessage(trimmed, true);
  userInput.value = '';
  setVoiceStatus('');

  const messagesForRequest = conversationHistory.concat({
    role: 'user',
    content: trimmed,
  });

  setLoading(true);
  showTypingIndicator();

  try {
    const reply = await fetchGeminiResponse(messagesForRequest);
    conversationHistory.push({ role: 'user', content: trimmed });
    conversationHistory.push({ role: 'assistant', content: reply });
    hideTypingIndicator();
    appendMessage(reply);
  } catch (error) {
    hideTypingIndicator();
    appendMessage(error.message || 'Kuch galat ho gaya. Phir se try karein.');
  } finally {
    setLoading(false);
    userInput.focus();
  }
}

function setupWelcomeSuggestions() {
  if (!welcomeSection) return;

  welcomeSection.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const suggestion = chip.getAttribute('data-suggestion') || chip.textContent;
      sendUserMessage(suggestion);
    });
  });
}

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await sendUserMessage(userInput.value);
});

setupVoiceControls();
setupWelcomeSuggestions();
