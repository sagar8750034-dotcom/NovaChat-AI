const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const chatWindow = document.getElementById('chatWindow');
const sendButton = document.getElementById('sendButton')
  || chatForm.querySelector('button[type="submit"]');
const cancelEditButton = document.getElementById('cancelEditButton');
const micButton = document.getElementById('micButton');
const voiceLangSelect = document.getElementById('voiceLangSelect');
const voiceStatus = document.getElementById('voiceStatus');
const welcomeSection = document.getElementById('welcomeSection');
const attachButton = document.getElementById('attachButton');
const attachMenu = document.getElementById('attachMenu');
const attachFileInput = document.getElementById('attachFileInput');
const attachmentPreview = document.getElementById('attachmentPreview');
const VOICE_LANG_STORAGE_KEY = 'novachat-voice-lang';
const ATTACHMENT_MAX_FILES = 8;
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_ALLOWED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'pdf', 'txt', 'doc', 'docx', 'csv', 'json',
  'py', 'js', 'html', 'css', 'md',
]);
const ATTACHMENT_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

/*
  Backend base URL for split Netlify (frontend) + Render (API) deploys.
  - Local Flask same-origin: empty config → relative URLs (including /auth/google).
  - Netlify production: always use the Render backend (never Netlify /auth/google).
  Never put API keys or secrets here.
*/
const PRODUCTION_API_BASE_URL = 'https://novachat-ai.onrender.com';

function resolveApiBaseUrl() {
  const candidates = [
    typeof window !== 'undefined' ? window.NOVACHAT_API_BASE_URL : '',
    typeof window !== 'undefined' ? window.API_BASE_URL : '',
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const raw = candidates[i] == null ? '' : String(candidates[i]).trim();
    if (raw) return raw.replace(/\/+$/, '');
  }

  // Netlify hosts must never call same-origin /auth/google (404).
  const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  if (
    host === 'novachat-ai-chatbot.netlify.app'
    || host.endsWith('.netlify.app')
    || host.endsWith('.netlify.live')
  ) {
    return PRODUCTION_API_BASE_URL;
  }
  return '';
}
const API_BASE_URL = resolveApiBaseUrl();

function apiUrl(path) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (!API_BASE_URL) return normalized;
  return `${API_BASE_URL.replace(/\/+$/, '')}${normalized}`;
}

function googleOAuthStartUrl() {
  return apiUrl('/auth/google');
}

function bindGoogleLoginHref() {
  const googleLoginButton = document.getElementById('googleLoginButton');
  if (!googleLoginButton) return;
  const oauthUrl = googleOAuthStartUrl();
  googleLoginButton.setAttribute('href', oauthUrl);
  // Hard guarantee: never navigate to Netlify /auth/google
  googleLoginButton.addEventListener('click', (event) => {
    event.preventDefault();
    window.location.assign(oauthUrl);
  });
}

// config.js loads before this file; bind immediately (scripts are at end of body).
bindGoogleLoginHref();

// In-memory session history (clears on page refresh / new session)
const conversationHistory = [];
let conversationId = null;

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSupported = Boolean(SpeechRecognitionAPI);
const ttsSupported = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

let recognition = null;
let isListening = false;
let activeSpeakButton = null;
let preferredTtsVoice = null;
let cachedTtsVoices = [];
let speakQueueTimer = null;
let speakKeepAliveTimer = null;
let speakQueue = [];
let speakGeneration = 0;
let isSending = false;
let editingMessageEl = null;
let pendingAttachments = [];
let attachMenuOpen = false;
const MESSAGE_MAX_CHARS = 8000;
const COMPOSER_PLACEHOLDER = (userInput && userInput.getAttribute('placeholder')) || 'Type your message...';

const authScreen = document.getElementById('authScreen');
const appShell = document.getElementById('appShell');
const authError = document.getElementById('authError');
const authHeading = document.getElementById('authHeading');
const authSubtitle = document.getElementById('authSubtitle');
const loginPanel = document.getElementById('loginPanel');
const signupPanel = document.getElementById('signupPanel');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const showSignupButton = document.getElementById('showSignupButton');
const showLoginButton = document.getElementById('showLoginButton');
const accountButton = document.getElementById('accountButton');
const accountFooterButton = document.getElementById('accountFooterButton');
const accountInitial = document.getElementById('accountInitial');
const accountRailPicture = document.getElementById('accountRailPicture');
const sidebarUserName = document.getElementById('sidebarUserName');
const sidebarUserEmail = document.getElementById('sidebarUserEmail');
const sidebarUserPicture = document.getElementById('sidebarUserPicture');
const sidebarUserEmoji = document.getElementById('sidebarUserEmoji');
const accountMenu = document.getElementById('accountMenu');
const accountDialog = document.getElementById('accountDialog');
const accountDialogTitle = document.getElementById('accountDialogTitle');
const accountDialogBody = document.getElementById('accountDialogBody');
const accountDialogClose = document.getElementById('accountDialogClose');
const searchToggle = document.getElementById('searchToggle');
const historySearchWrap = document.getElementById('historySearchWrap');
const historySearchInput = document.getElementById('historySearchInput');
const sidebarPanelTitle = document.getElementById('sidebarPanelTitle');
const newChatPanelButton = document.getElementById('newChatPanelButton');
const settingsButton = document.getElementById('settingsButton');
const logoutButton = document.getElementById('logoutButton');

let currentUser = null;
let appReady = false;
let sidebarMode = null;
let searchDebounce = null;
let sidebarInitialized = false;

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

function resizeComposer() {
  if (!userInput || userInput.tagName !== 'TEXTAREA') return;
  userInput.style.height = 'auto';
  userInput.style.height = `${Math.min(userInput.scrollHeight, 160)}px`;
}

function hideWelcomeSection() {
  if (welcomeSection) {
    welcomeSection.classList.add('is-hidden');
  }
}

function getGreetingFirstName() {
  // Only use the authenticated session user's display name — never email or client-supplied values.
  const fullName = currentUser && typeof currentUser.name === 'string'
    ? currentUser.name.trim()
    : '';
  if (!fullName) return '';
  return fullName.split(/\s+/)[0];
}

function updateWelcomeGreeting() {
  const greetingEl = document.getElementById('welcomeGreeting');
  if (!greetingEl) return;
  const firstName = getGreetingFirstName();
  greetingEl.textContent = firstName
    ? `Hi ${firstName}! How are you today?`
    : 'Hi! How are you today?';
}

function showWelcomeSection() {
  updateWelcomeGreeting();
  if (welcomeSection) welcomeSection.classList.remove('is-hidden');
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

function cleanTextForSpeech(raw) {
  // TTS-only normalization. On-screen message text is never modified.
  let value = String(raw || '');
  if (!value.trim()) return '';

  const fence = '```';
  const tick = '`';
  const fencePattern = new RegExp(fence + '[\\s\\S]*?' + fence, 'g');
  const tickPattern = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');

  value = value.replace(fencePattern, ' ');
  value = value.replace(tickPattern, '$1');
  value = value.replace(/<[^>]+>/g, ' ');
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  value = value.replace(/\bhttps?:\/\/\S+/gi, '');
  value = value.replace(/\bwww\.\S+/gi, '');
  value = value.replace(/^#{1,6}\s+/gm, '');
  value = value.replace(/^\s{0,3}>\s?/gm, '');
  value = value.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');
  value = value.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2');
  value = value.replace(/(\*|_)([^*\n]+)\1/g, '$2');
  value = value.replace(/~~([^~]+)~~/g, '$1');
  value = value.replace(/^\s*[-*+]\s+/gm, '');
  value = value.replace(/^\s*\d+[.)]\s+/gm, '');
  value = value.replace(/[*_~#>`]+/g, ' ');
  // Keep flow conversational — avoid turning every line break into a full stop.
  value = value.replace(/\n+/g, ' ');
  value = value.replace(/\s+/g, ' ');
  value = value.replace(/\s*([,;:!?])\s*/g, '$1 ');
  value = value.replace(/([.!?।])\s*[.।]+/g, '$1');
  value = value.replace(/\s+\./g, '.');
  value = value.replace(/\.{2,}/g, '.');
  return value.replace(/\s+/g, ' ').trim();
}

function getCachedVoices() {
  if (!ttsSupported) return [];
  const live = window.speechSynthesis.getVoices() || [];
  if (live.length) cachedTtsVoices = live;
  return cachedTtsVoices.length ? cachedTtsVoices : live;
}

function normalizeVoiceLang(lang) {
  return String(lang || '').toLowerCase().replace(/_/g, '-');
}

function getInputVoiceLang() {
  return voiceLangSelect && voiceLangSelect.value === 'hi' ? 'hi' : 'en';
}

function getComposerPlaceholder() {
  return getInputVoiceLang() === 'hi'
    ? 'अपना संदेश लिखें या बोलें...'
    : COMPOSER_PLACEHOLDER;
}

function getRecognitionLang() {
  return getInputVoiceLang() === 'hi' ? 'hi-IN' : 'en-IN';
}

function detectSpeechLang(text) {
  const source = String(text || '');
  const hindiChars = (source.match(/[\u0900-\u097F]/g) || []).length;
  const latinChars = (source.match(/[A-Za-z]/g) || []).length;
  const totalLetters = hindiChars + latinChars;
  if (!totalLetters) return 'en';

  // Mixed Hindi/English (Hinglish): use a Hindi or en-IN voice when possible.
  if (hindiChars >= 3 && latinChars >= 8) return 'mixed';
  if (hindiChars >= 8) return 'hi';
  if (hindiChars >= 3 && hindiChars / totalLetters >= 0.35) return 'hi';
  if (hindiChars > latinChars && hindiChars >= 3) return 'hi';
  return 'en';
}

function getSpeechSettings(speechLang) {
  // Casual conversational delivery — not a newsreader or announcement tone.
  if (speechLang === 'hi') {
    return { rate: 0.98, pitch: 0.90, volume: 0.95 };
  }
  if (speechLang === 'mixed') {
    return { rate: 1.0, pitch: 0.90, volume: 0.95 };
  }
  return { rate: 1.0, pitch: 0.88, volume: 0.95 };
}

function getBestVoiceForLang(langCode) {
  const voices = getCachedVoices();
  if (!voices.length) return null;

  const want = langCode === 'hi' || langCode === 'mixed' ? 'hi' : 'en';
  let matching = voices.filter((voice) => normalizeVoiceLang(voice.lang).startsWith(want));

  // Hinglish fallback: prefer Hindi first, then Indian English.
  if (langCode === 'mixed' && !matching.length) {
    matching = voices.filter((voice) => {
      const lang = normalizeVoiceLang(voice.lang);
      return lang.startsWith('en-in') || lang.startsWith('en');
    });
  }
  if (!matching.length && want === 'hi') {
    matching = voices.filter((voice) => normalizeVoiceLang(voice.lang).startsWith('en-in'));
  }
  if (!matching.length) return null;

  const preferredMale = [
    'david', 'mark', 'ryan', 'guy', 'james', 'daniel', 'george', 'alex',
    'ravi', 'rishi', 'hemant', 'prabhat',
  ];
  const casualHints = ['natural', 'neural', 'online', 'premium', 'enhanced'];
  const avoidHints = [
    'zira', 'espeak', 'compact', 'robot', 'whisper', 'samantha', 'hazel',
    'susan', 'karen', 'moira', 'tessa', 'fiona', 'veena', 'heera',
    'news', 'announce', 'narrator',
  ];

  const scoreVoice = (voice) => {
    const name = String(voice.name || '').toLowerCase();
    const lang = normalizeVoiceLang(voice.lang);
    const tokens = name.split(/[^a-z0-9]+/).filter(Boolean);
    let score = 10;

    if (want === 'hi' || langCode === 'mixed') {
      if (lang.startsWith('hi-in')) score += 22;
      else if (lang.startsWith('hi')) score += 14;
      else if (lang.startsWith('en-in')) score += 12;
    } else if (lang.startsWith('en-in')) {
      // Conversational Indian English often sounds more natural for this product.
      score += 18;
    } else if (lang.startsWith('en-us')) {
      score += 14;
    } else if (lang.startsWith('en-gb') || lang.startsWith('en-uk') || lang.startsWith('en-au')) {
      score += 10;
    } else {
      score += 4;
    }

    preferredMale.forEach((hint) => {
      if (tokens.includes(hint) || name.includes(hint)) score += 24;
    });
    if (/(^|[^a-z])male([^a-z]|$)/.test(name)) score += 16;
    casualHints.forEach((hint) => {
      if (name.includes(hint)) score += 8;
    });
    if (name.includes('google')) score += 10;
    if (name.includes('microsoft')) score += 7;
    if (name.includes('apple')) score += 4;

    avoidHints.forEach((hint) => {
      if (name.includes(hint)) score -= 22;
    });
    if (/(^|[^a-z])female([^a-z]|$)/.test(name)) score -= 10;
    return score;
  };

  return matching.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
}

function refreshPreferredVoice() {
  preferredTtsVoice = getBestVoiceForLang('en');
}

if (ttsSupported) {
  refreshPreferredVoice();
  const rememberVoices = () => {
    getCachedVoices();
    refreshPreferredVoice();
  };
  window.speechSynthesis.addEventListener('voiceschanged', rememberVoices);
  window.speechSynthesis.onvoiceschanged = rememberVoices;
  setTimeout(rememberVoices, 250);
  setTimeout(rememberVoices, 1000);
}

function splitSpeakableChunks(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  // Larger chunks keep speech more conversational and less choppy.
  const maxLen = 320;
  const pieces = [];
  const sentences = normalized.match(/[^.!?…।]+[.!?…।]+|[^.!?…।]+$/g) || [normalized];
  let current = '';
  sentences.forEach((rawSentence) => {
    const sentence = rawSentence.trim();
    if (!sentence) return;
    if (current && current.length + 1 + sentence.length > maxLen) {
      pieces.push(current);
      current = '';
    }
    current = current ? current + ' ' + sentence : sentence;
    while (current.length > maxLen) {
      let cut = current.lastIndexOf(', ', maxLen);
      if (cut < 60) cut = current.lastIndexOf(' ', maxLen);
      if (cut < 60) cut = maxLen;
      pieces.push(current.slice(0, cut).trim());
      current = current.slice(cut).replace(/^[,.\s]+/, '').trim();
    }
  });
  if (current) pieces.push(current);
  return pieces.filter(Boolean);
}

function resetSpeakButton(button) {
  if (!button) return;
  button.classList.remove('is-speaking', 'is-loading');
  button.setAttribute('aria-label', 'Read aloud');
  button.title = 'Read aloud';
  button.textContent = '🔊';
  button.disabled = false;
}

function setSpeakButtonPlaying(button) {
  if (!button) return;
  button.classList.remove('is-loading');
  button.classList.add('is-speaking');
  button.setAttribute('aria-label', 'Stop speaking');
  button.title = 'Stop speaking';
  button.textContent = '⏹';
}

function stopSpeaking() {
  speakGeneration += 1;
  speakQueue = [];
  if (speakQueueTimer) {
    clearTimeout(speakQueueTimer);
    speakQueueTimer = null;
  }
  if (speakKeepAliveTimer) {
    clearInterval(speakKeepAliveTimer);
    speakKeepAliveTimer = null;
  }
  if (ttsSupported) {
    window.speechSynthesis.cancel();
  }
  if (activeSpeakButton) {
    resetSpeakButton(activeSpeakButton);
    activeSpeakButton = null;
  }
}

function speakText(text, button) {
  if (!ttsSupported) {
    setVoiceStatus('Voice playback is not supported in this browser. Try Chrome or Edge.');
    return;
  }

  const original = String(text || '');
  const speakable = cleanTextForSpeech(original);
  if (!speakable) return;

  if (button && activeSpeakButton === button) {
    stopSpeaking();
    return;
  }

  stopSpeaking();

  const chunks = splitSpeakableChunks(speakable);
  if (!chunks.length) return;

  const speechLang = detectSpeechLang(original);
  const voices = getCachedVoices();
  const voice = voices.length ? getBestVoiceForLang(speechLang) : null;
  const settings = getSpeechSettings(speechLang);
  const fallbackLang = speechLang === 'hi' || speechLang === 'mixed' ? 'hi-IN' : 'en-IN';

  if (voices.length && !voice) {
    setVoiceStatus(
      speechLang === 'hi' || speechLang === 'mixed'
        ? 'No Hindi voice is available on this device. Using the default voice.'
        : 'No English voice is available on this device. Using the default voice.'
    );
  }

  speakQueue = chunks.slice();
  const generation = speakGeneration;
  if (button) {
    activeSpeakButton = button;
    setSpeakButtonPlaying(button);
  }

  const startKeepAlive = () => {
    if (speakKeepAliveTimer) clearInterval(speakKeepAliveTimer);
    speakKeepAliveTimer = setInterval(() => {
      if (!ttsSupported || generation !== speakGeneration) return;
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    }, 8000);
  };

  const speakChunk = (chunk, isLast) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang || fallbackLang;
    } else {
      utterance.lang = fallbackLang;
    }
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;

    utterance.onstart = () => {
      if (generation !== speakGeneration) return;
      if (button) setSpeakButtonPlaying(button);
    };
    utterance.onend = () => {
      if (generation !== speakGeneration) return;
      if (isLast) {
        if (speakKeepAliveTimer) {
          clearInterval(speakKeepAliveTimer);
          speakKeepAliveTimer = null;
        }
        if (activeSpeakButton === button) {
          resetSpeakButton(button);
          activeSpeakButton = null;
        }
      }
    };
    utterance.onerror = (event) => {
      if (generation !== speakGeneration) return;
      const name = event && event.error;
      if (name === 'interrupted' || name === 'canceled') return;
      if (activeSpeakButton === button) {
        resetSpeakButton(button);
        activeSpeakButton = null;
      }
      setVoiceStatus('Could not play this reply. Please try again.');
    };

    window.speechSynthesis.speak(utterance);
  };

  startKeepAlive();
  // Queue every chunk inside this click so Chrome/Edge keep user activation.
  chunks.forEach((chunk, index) => {
    speakChunk(chunk, index === chunks.length - 1);
  });
}

function createSpeakButton(speakTextValue) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'speak-button';
  button.setAttribute('aria-label', 'Read aloud');
  button.title = ttsSupported ? 'Read aloud' : 'Voice playback is not supported in this browser.';
  button.textContent = '🔊';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    speakText(speakTextValue, button);
  });
  return button;
}

function visibleChatMessages() {
  return [...chatWindow.querySelectorAll('.message:not(.typing-indicator)')];
}

function getMessagePlainText(bubble) {
  if (!bubble) return '';
  const contentEl = bubble.querySelector('.message-content');
  if (!contentEl) return '';
  return String(contentEl.innerText || contentEl.textContent || '').trim();
}

function messageBubbleFromAction(el) {
  if (!el) return null;
  const group = el.closest('.message-group');
  if (group) return group.querySelector('.message');
  return el.closest('.message');
}

function createActionSvg(pathD) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', pathD);
  svg.appendChild(path);
  return svg;
}

function createMessageActionButton(kind, label, ariaLabel, pathD) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `message-action-btn message-action-${kind}`;
  button.setAttribute('aria-label', ariaLabel);
  button.title = label;
  button.appendChild(createActionSvg(pathD));
  const text = document.createElement('span');
  text.className = 'message-action-label';
  text.textContent = label;
  button.appendChild(text);
  return button;
}

function createUserMessageActions() {
  const row = document.createElement('div');
  row.className = 'message-actions';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Message actions');
  row.appendChild(createMessageActionButton(
    'edit',
    'Edit',
    'Edit message',
    'M4 16.5V20h3.5L19.06 8.44a1.5 1.5 0 0 0 0-2.12l-1.38-1.38a1.5 1.5 0 0 0-2.12 0L4 16.5Zm2.92 1.58H6v-.92l9.37-9.37.92.92L6.92 18.08Z'
  ));
  row.appendChild(createMessageActionButton(
    'copy',
    'Copy',
    'Copy message',
    'M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H10V7h9v14Z'
  ));
  row.appendChild(createMessageActionButton(
    'share',
    'Share',
    'Share message',
    'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7a3.1 3.1 0 0 0 0-1.39l7.02-4.11A2.99 2.99 0 1 0 14 5a3 3 0 0 0 .05.54L7.03 9.65a3 3 0 1 0 0 4.7l7.02 4.11c-.03.17-.05.35-.05.54a3 3 0 1 0 3-3Z'
  ));
  return row;
}

function setUserMessageActionsVisible(group, visible) {
  if (!group) return;
  const bubble = group.querySelector('.user-message');
  group.classList.toggle('message-actions-visible', Boolean(visible));
  if (bubble) bubble.setAttribute('aria-expanded', visible ? 'true' : 'false');
}

function hideAllUserMessageActions(exceptGroup = null) {
  if (!chatWindow) return;
  chatWindow.querySelectorAll('.message-group-user.message-actions-visible').forEach((group) => {
    if (exceptGroup && group === exceptGroup) return;
    setUserMessageActionsVisible(group, false);
  });
}

function toggleUserMessageActions(group) {
  if (!group) return;
  const willShow = !group.classList.contains('message-actions-visible');
  hideAllUserMessageActions(willShow ? group : null);
  setUserMessageActionsVisible(group, willShow);
}

function flashActionFeedback(button, feedbackText) {
  if (!button) return;
  const label = button.querySelector('.message-action-label');
  const previousTitle = button.title;
  const previousLabel = label ? label.textContent : '';
  button.classList.add('is-copied');
  button.title = feedbackText;
  if (label) label.textContent = feedbackText;
  window.setTimeout(() => {
    button.classList.remove('is-copied');
    button.title = previousTitle || previousLabel || '';
    if (label) label.textContent = previousLabel;
  }, 1200);
}

async function writeTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

async function copyMessageText(bubble, button) {
  const text = getMessagePlainText(bubble);
  if (!text) {
    setVoiceStatus('Nothing to copy.');
    return;
  }

  try {
    await writeTextToClipboard(text);
    flashActionFeedback(button, 'Copied');
    setVoiceStatus('Copied');
    window.setTimeout(() => {
      if (voiceStatus && voiceStatus.textContent === 'Copied') setVoiceStatus('');
    }, 1200);
  } catch (_) {
    setVoiceStatus('Could not copy. Please try again.');
  }
}

async function shareMessageText(bubble, button) {
  const text = getMessagePlainText(bubble);
  if (!text) {
    setVoiceStatus('Nothing to share.');
    return;
  }

  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: 'NovaChat AI',
        text,
      });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // Fall through to clipboard fallback.
    }
  }

  try {
    await writeTextToClipboard(text);
    flashActionFeedback(button, 'Copied');
    setVoiceStatus('Message copied');
    window.setTimeout(() => {
      if (voiceStatus && voiceStatus.textContent === 'Message copied') setVoiceStatus('');
    }, 1200);
  } catch (_) {
    setVoiceStatus('Could not share. Please try again.');
  }
}

function setMessageId(element, messageId) {
  if (!element || !messageId) return;
  element.dataset.messageId = messageId;
  const group = element.closest('.message-group');
  const editButton = (group || element).querySelector('.message-action-edit');
  if (editButton) {
    editButton.disabled = isSending;
  }
}

function bindMessageActionDelegation() {
  if (!chatWindow || chatWindow.dataset.messageActionsBound === '1') return;
  chatWindow.dataset.messageActionsBound = '1';

  chatWindow.addEventListener('click', (event) => {
    const editBtn = event.target.closest('.message-action-edit');
    if (editBtn && chatWindow.contains(editBtn)) {
      event.preventDefault();
      event.stopPropagation();
      if (isSending || editBtn.disabled) return;
      beginEditMessage(messageBubbleFromAction(editBtn));
      return;
    }

    const copyBtn = event.target.closest('.message-action-copy');
    if (copyBtn && chatWindow.contains(copyBtn)) {
      event.preventDefault();
      event.stopPropagation();
      copyMessageText(messageBubbleFromAction(copyBtn), copyBtn);
      return;
    }

    const shareBtn = event.target.closest('.message-action-share');
    if (shareBtn && chatWindow.contains(shareBtn)) {
      event.preventDefault();
      event.stopPropagation();
      shareMessageText(messageBubbleFromAction(shareBtn), shareBtn);
      return;
    }

    // Clicks on the action row itself should not toggle visibility.
    if (event.target.closest('.message-actions')) {
      event.stopPropagation();
      return;
    }

    const userBubble = event.target.closest('.user-message');
    if (userBubble && chatWindow.contains(userBubble)) {
      event.stopPropagation();
      toggleUserMessageActions(userBubble.closest('.message-group-user'));
    }
  });

  chatWindow.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const userBubble = event.target.closest('.user-message');
    if (!userBubble || event.target !== userBubble) return;
    if (!chatWindow.contains(userBubble)) return;
    event.preventDefault();
    toggleUserMessageActions(userBubble.closest('.message-group-user'));
  });

  if (document.documentElement.dataset.messageActionsOutsideBound !== '1') {
    document.documentElement.dataset.messageActionsOutsideBound = '1';
    document.addEventListener('click', (event) => {
      if (event.target.closest('.message-group-user')) return;
      hideAllUserMessageActions();
    });
  }
}

bindMessageActionDelegation();

function fileExtension(name) {
  const parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isAllowedAttachmentFile(file) {
  if (!file) return false;
  const ext = fileExtension(file.name);
  if (ext && ATTACHMENT_ALLOWED_EXTENSIONS.has(ext)) return true;
  const type = String(file.type || '').toLowerCase();
  if (ATTACHMENT_IMAGE_TYPES.has(type)) return true;
  // Clipboard screenshots sometimes lack a filename extension.
  if (!file.name && type.startsWith('image/')) {
    const subtype = type.split('/')[1];
    return ATTACHMENT_ALLOWED_EXTENSIONS.has(subtype === 'jpeg' ? 'jpg' : subtype);
  }
  return false;
}

function normalizeClipboardFile(file, index) {
  if (!file) return null;
  if (file.name && file.name.trim()) return file;
  const type = String(file.type || 'image/png').toLowerCase();
  let ext = 'png';
  if (type === 'image/jpeg' || type === 'image/jpg') ext = 'jpg';
  else if (type === 'image/webp') ext = 'webp';
  else if (type === 'image/gif') ext = 'gif';
  else if (type.includes('/')) {
    const subtype = type.split('/')[1];
    if (ATTACHMENT_ALLOWED_EXTENSIONS.has(subtype)) ext = subtype;
  }
  const name = `pasted-image-${Date.now()}-${index + 1}.${ext}`;
  try {
    return new File([file], name, { type: file.type || `image/${ext}` });
  } catch (_) {
    return file;
  }
}

function closeAttachMenu() {
  if (!attachMenu) return;
  attachMenu.hidden = true;
  attachMenuOpen = false;
  if (attachButton) {
    attachButton.setAttribute('aria-expanded', 'false');
  }
}

function openAttachMenu() {
  if (!attachMenu || !attachButton) return;
  attachMenu.hidden = false;
  attachMenuOpen = true;
  attachButton.setAttribute('aria-expanded', 'true');
  const firstItem = attachMenu.querySelector('[data-attach-action]');
  if (firstItem) firstItem.focus();
}

function toggleAttachMenu() {
  if (attachMenuOpen) closeAttachMenu();
  else openAttachMenu();
}

function clearPendingAttachments({ revoke = true } = {}) {
  pendingAttachments.forEach((item) => {
    if (revoke && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  });
  pendingAttachments = [];
  renderAttachmentPreview();
}

function removePendingAttachment(id) {
  const idx = pendingAttachments.findIndex((item) => item.id === id);
  if (idx < 0) return;
  const [removed] = pendingAttachments.splice(idx, 1);
  if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  if (!attachmentPreview) return;
  attachmentPreview.innerHTML = '';
  if (!pendingAttachments.length) {
    attachmentPreview.hidden = true;
    return;
  }
  attachmentPreview.hidden = false;
  pendingAttachments.forEach((item) => {
    attachmentPreview.appendChild(createAttachmentChip(item, true));
  });
}

function createAttachmentChip(item, removable) {
  const chip = document.createElement('div');
  chip.className = 'attachment-chip';
  chip.dataset.attachmentId = item.id;

  const isImage = Boolean(item.previewUrl) || String(item.contentType || '').startsWith('image/');
  if (isImage && item.previewUrl) {
    const img = document.createElement('img');
    img.className = 'attachment-chip-thumb';
    img.src = item.previewUrl;
    img.alt = item.name || 'Image attachment';
    chip.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'attachment-chip-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '📄';
    chip.appendChild(icon);
  }

  const meta = document.createElement('div');
  meta.className = 'attachment-chip-meta';
  const nameEl = document.createElement('div');
  nameEl.className = 'attachment-chip-name';
  nameEl.textContent = item.name || 'attachment';
  const subEl = document.createElement('div');
  subEl.className = 'attachment-chip-sub';
  const ext = (item.extension || fileExtension(item.name) || 'file').toUpperCase();
  subEl.textContent = `${ext} · ${formatFileSize(item.size)}`;
  meta.appendChild(nameEl);
  meta.appendChild(subEl);
  chip.appendChild(meta);

  if (removable) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'attachment-chip-remove';
    removeBtn.setAttribute('aria-label', `Remove ${item.name || 'attachment'}`);
    removeBtn.title = 'Remove attachment';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      removePendingAttachment(item.id);
    });
    chip.appendChild(removeBtn);
  }

  return chip;
}

function addPendingFiles(fileList) {
  const incoming = Array.from(fileList || []).filter(Boolean);
  if (!incoming.length) return 0;

  let added = 0;
  for (let i = 0; i < incoming.length; i += 1) {
    if (pendingAttachments.length >= ATTACHMENT_MAX_FILES) {
      setVoiceStatus(`You can attach up to ${ATTACHMENT_MAX_FILES} files.`);
      break;
    }
    let file = incoming[i];
    file = normalizeClipboardFile(file, i) || file;
    if (!isAllowedAttachmentFile(file)) continue;
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setVoiceStatus(`"${file.name}" is too large (max ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB).`);
      continue;
    }
    if (file.size <= 0) continue;

    const ext = fileExtension(file.name);
    const contentType = file.type || 'application/octet-stream';
    const previewUrl = contentType.startsWith('image/') || ATTACHMENT_IMAGE_TYPES.has(contentType)
      ? URL.createObjectURL(file)
      : null;
    pendingAttachments.push({
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      file,
      name: file.name,
      extension: ext,
      contentType,
      size: file.size,
      previewUrl,
    });
    added += 1;
  }
  if (added) renderAttachmentPreview();
  return added;
}

function collectClipboardFiles(clipboardData) {
  if (!clipboardData) return [];
  const collected = [];
  const seen = new Set();

  const pushFile = (file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    collected.push(file);
  };

  if (clipboardData.files && clipboardData.files.length) {
    Array.from(clipboardData.files).forEach(pushFile);
  }

  const items = clipboardData.items;
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || item.kind !== 'file') continue;
      try {
        pushFile(item.getAsFile());
      } catch (_) {
        // Browser did not expose a file — ignore silently.
      }
    }
  }

  return collected.filter(isAllowedAttachmentFile);
}

function buildMessageContentWithAttachments(text, uploadedMeta) {
  const base = String(text || '').trim();
  if (!uploadedMeta || !uploadedMeta.length) return base;
  const lines = uploadedMeta.map((item) => {
    const name = item.name || 'attachment';
    const ext = (item.extension || fileExtension(name) || 'file').toUpperCase();
    return `- ${name} (${ext}, ${formatFileSize(item.size)})`;
  });
  const note = `Attached files:\n${lines.join('\n')}`;
  return base ? `${base}\n\n${note}` : note;
}

async function uploadPendingAttachments() {
  if (!pendingAttachments.length) return [];
  const formData = new FormData();
  pendingAttachments.forEach((item) => {
    formData.append('files', item.file, item.name || item.file.name || 'attachment');
  });
  const response = await apiFetch('/api/attachments', {
    method: 'POST',
    body: formData,
  });
  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }
  if (response.status === 401) {
    throw new Error('Please log in to continue.');
  }
  if (!response.ok) {
    throw new Error(data.error || 'Could not upload attachments. Please try again.');
  }
  return Array.isArray(data.attachments) ? data.attachments : [];
}

function appendMessage(text, isUser = false, messageId = null, attachmentItems = null) {
  const message = document.createElement('div');
  message.className = `message ${isUser ? 'user-message' : 'bot-message'}`;

  if (isUser) {
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = text;
    message.appendChild(content);
    if (attachmentItems && attachmentItems.length) {
      const wrap = document.createElement('div');
      wrap.className = 'message-attachments';
      attachmentItems.forEach((item) => {
        wrap.appendChild(createAttachmentChip({
          id: item.id || item.name,
          name: item.name,
          extension: item.extension || fileExtension(item.name),
          size: item.size,
          contentType: item.contentType || item.content_type,
          previewUrl: item.previewUrl || null,
        }, false));
      });
      message.appendChild(wrap);
    }

    message.tabIndex = 0;
    message.setAttribute('aria-expanded', 'false');
    message.setAttribute('aria-label', 'Your message. Activate to show actions.');

    if (messageId) setMessageId(message, messageId);

    const group = document.createElement('div');
    group.className = 'message-group message-group-user';
    group.appendChild(message);
    group.appendChild(createUserMessageActions());
    chatWindow.appendChild(group);
    scrollChatToBottom();
    return message;
  }

  const content = document.createElement('div');
  content.className = 'message-content';
  // Sanitized Markdown only — never assign raw AI HTML directly.
  content.innerHTML = renderMarkdownSafely(text);
  message.appendChild(content);

  const plainText = content.innerText || text;
  message.appendChild(createSpeakButton(plainText));

  if (messageId) setMessageId(message, messageId);

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
  if (attachButton) attachButton.disabled = isLoading;
  if (attachFileInput) attachFileInput.disabled = isLoading;
  document.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.disabled = isLoading;
  });
  document.querySelectorAll('.message-action-edit').forEach((button) => {
    button.disabled = isLoading;
  });
  if (cancelEditButton) cancelEditButton.disabled = isLoading;
  if (isLoading) closeAttachMenu();
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

  const recognitionLang = getRecognitionLang();
  const hindiInput = getInputVoiceLang() === 'hi';

  recognition = new SpeechRecognitionAPI();
  recognition.lang = recognitionLang;
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    micButton.classList.add('is-listening');
    micButton.setAttribute('aria-pressed', 'true');
    micButton.setAttribute('aria-label', 'Stop recording');
    micButton.title = 'Stop recording';
    setVoiceStatus(
      hindiInput ? 'Listening... हिंदी में बोलें' : 'Listening... speak now',
      { listening: true }
    );
  };

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      transcript += event.results[i][0].transcript;
    }
    transcript = transcript.trim();
    if (transcript) {
      userInput.value = transcript;
      resizeComposer();
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
    } else if (error === 'language-not-supported') {
      setVoiceStatus(
        hindiInput
          ? 'Hindi voice input is not supported in this browser.'
          : 'English voice input is not supported in this browser.'
      );
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

function applyVoiceLangUi() {
  if (userInput && !editingMessageEl) {
    userInput.setAttribute('placeholder', getComposerPlaceholder());
  }
  if (micButton && speechSupported) {
    const hindi = getInputVoiceLang() === 'hi';
    if (!isListening) {
      micButton.title = hindi ? 'Voice input (हिंदी)' : 'Voice input (English)';
      micButton.setAttribute('aria-label', hindi ? 'Voice input in Hindi' : 'Voice input in English');
    }
  }
}

function setupVoiceControls() {
  if (voiceLangSelect) {
    try {
      const saved = localStorage.getItem(VOICE_LANG_STORAGE_KEY);
      if (saved === 'hi' || saved === 'en') {
        voiceLangSelect.value = saved;
      }
    } catch (_) {
      // Ignore storage errors; selector still works for this session.
    }

    voiceLangSelect.addEventListener('change', () => {
      try {
        localStorage.setItem(VOICE_LANG_STORAGE_KEY, getInputVoiceLang());
      } catch (_) {
        // Ignore storage errors.
      }
      if (isListening) stopListening();
      applyVoiceLangUi();
    });
  }

  applyVoiceLangUi();

  if (!micButton) return;

  if (!speechSupported) {
    micButton.disabled = true;
    micButton.title = 'Voice input is not supported in this browser. Try Chrome or Edge.';
    micButton.setAttribute('aria-disabled', 'true');
    if (voiceLangSelect) voiceLangSelect.disabled = true;
    return;
  }

  micButton.addEventListener('click', () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });
}

async function fetchGeminiResponse(messages, attachmentIds = []) {
  const body = { messages };
  if (conversationId) {
    body.conversation_id = conversationId;
  }
  if (attachmentIds && attachmentIds.length) {
    body.attachment_ids = attachmentIds;
  }

  const t0 = performance.now();
  console.info('[chat timing] frontend_request_start', 0);

  const response = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.info('[chat timing] frontend_response_headers', Math.round(performance.now() - t0));

  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('Server se valid response nahi mila.');
  }

  console.info('[chat timing] frontend_response_json', Math.round(performance.now() - t0));

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Please log in to continue.');
    }
    throw new Error(data.error || 'Gemini se jawab nahi mil paya. Thodi der baad try karein.');
  }

  if (!data.reply) {
    throw new Error('Gemini se response nahi mila.');
  }

  if (data.conversation_id) {
    conversationId = data.conversation_id;
  }

  return data;
}

function beginStreamingBotMessage() {
  hideTypingIndicator();
  const message = document.createElement('div');
  message.className = 'message bot-message';
  const content = document.createElement('div');
  content.className = 'message-content';
  message.appendChild(content);
  chatWindow.appendChild(message);
  scrollChatToBottom();
  return { message, content };
}

function updateStreamingBotMessage(contentEl, text) {
  contentEl.textContent = text;
  scrollChatToBottom();
}

function finalizeStreamingBotMessage(message, contentEl, text, messageId) {
  contentEl.innerHTML = renderMarkdownSafely(text);
  const plainText = contentEl.innerText || text;
  if (!message.querySelector('.speak-button')) {
    message.appendChild(createSpeakButton(plainText));
  }
  if (messageId) setMessageId(message, messageId);
  scrollChatToBottom();
}

async function fetchGeminiResponseStream(messages, onDelta, attachmentIds = []) {
  const body = { messages };
  if (conversationId) {
    body.conversation_id = conversationId;
  }
  if (attachmentIds && attachmentIds.length) {
    body.attachment_ids = attachmentIds;
  }

  const t0 = performance.now();
  console.info('[chat timing] 01_frontend_request_start', 0, { endpoint: '/api/chat/stream' });

  const response = await apiFetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  });

  console.info('[chat timing] 02_frontend_headers_received', Math.round(performance.now() - t0));

  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      // ignore
    }
    if (response.status === 401) {
      throw new Error('Please log in to continue.');
    }
    throw new Error(data.error || 'Gemini se jawab nahi mil paya. Thodi der baad try karein.');
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    // Old browsers: fall back to non-streaming JSON chat.
    return fetchGeminiResponse(messages, attachmentIds);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let donePayload = null;
  let sawFirstDelta = false;
  let deltaEvents = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineAt = buffer.indexOf('\n');
    while (newlineAt >= 0) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      newlineAt = buffer.indexOf('\n');
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (event.type === 'delta' && event.text) {
        deltaEvents += 1;
        if (!sawFirstDelta) {
          console.info('[chat timing] 03_frontend_first_token', Math.round(performance.now() - t0), {
            chunk_chars: event.text.length,
            progressive: true,
          });
          sawFirstDelta = true;
        }
        fullText += event.text;
        if (typeof onDelta === 'function') onDelta(fullText);
      } else if (event.type === 'error') {
        throw new Error(event.error || 'Gemini se jawab nahi mil paya. Thodi der baad try karein.');
      } else if (event.type === 'done') {
        donePayload = event;
        if (event.reply) fullText = event.reply;
        console.info('[chat timing] 04_frontend_done_event', Math.round(performance.now() - t0), {
          delta_events: deltaEvents,
        });
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim());
      if (event.type === 'done') {
        donePayload = event;
        if (event.reply) fullText = event.reply;
      } else if (event.type === 'error') {
        throw new Error(event.error || 'Gemini se jawab nahi mil paya. Thodi der baad try karein.');
      }
    } catch (err) {
      if (err && err.message && !err.message.includes('JSON')) throw err;
    }
  }

  const reply = (donePayload && donePayload.reply) || fullText;
  if (!reply) {
    throw new Error('Gemini se response nahi mila.');
  }

  if (donePayload && donePayload.conversation_id) {
    conversationId = donePayload.conversation_id;
  }

  console.info('[chat timing] 05_frontend_stream_complete', Math.round(performance.now() - t0), {
    delta_events: deltaEvents,
    progressive_chunks: deltaEvents > 1,
    first_token_seen: sawFirstDelta,
    tts_on_send: false,
  });

  return {
    reply,
    conversation_id: (donePayload && donePayload.conversation_id) || conversationId,
    user_message_id: (donePayload && donePayload.user_message_id) || null,
    assistant_message_id: (donePayload && donePayload.assistant_message_id) || null,
  };
}

function historyIndexForBubble(bubble) {
  if (!bubble) return -1;
  if (bubble.dataset.messageId) {
    return conversationHistory.findIndex((msg) => msg.id === bubble.dataset.messageId);
  }
  const userBubbles = [...chatWindow.querySelectorAll('.user-message')];
  const uiIndex = userBubbles.indexOf(bubble);
  if (uiIndex < 0) return -1;
  const userEntries = conversationHistory
    .map((msg, index) => ({ msg, index }))
    .filter((item) => item.msg.role === 'user');
  return userEntries[uiIndex] ? userEntries[uiIndex].index : -1;
}

function cancelEditMode({ restoreInput = true } = {}) {
  if (editingMessageEl) {
    editingMessageEl.classList.remove('is-editing');
    const group = editingMessageEl.closest('.message-group');
    if (group) group.classList.remove('is-editing');
  }
  editingMessageEl = null;
  if (chatForm) chatForm.classList.remove('is-editing');
  if (sendButton) sendButton.textContent = 'Send';
  if (cancelEditButton) cancelEditButton.hidden = true;
  if (userInput) {
    userInput.setAttribute('placeholder', getComposerPlaceholder());
    if (restoreInput) {
      userInput.value = '';
      resizeComposer();
    }
  }
}

function beginEditMessage(bubble) {
  if (!bubble || isSending) return;
  if (!bubble.classList.contains('user-message')) {
    setVoiceStatus('Only your messages can be edited.');
    return;
  }

  const index = historyIndexForBubble(bubble);
  const entry = index >= 0 ? conversationHistory[index] : null;
  const domText = getMessagePlainText(bubble);
  // Prefer visible bubble text so attachment notes / display text stay accurate.
  const text = domText || (entry && entry.role === 'user' ? (entry.content || '') : '');
  if (!text) {
    setVoiceStatus('Could not load that message for editing.');
    return;
  }

  if (editingMessageEl && editingMessageEl !== bubble) {
    editingMessageEl.classList.remove('is-editing');
    const prevGroup = editingMessageEl.closest('.message-group');
    if (prevGroup) prevGroup.classList.remove('is-editing');
  }

  editingMessageEl = bubble;
  bubble.classList.add('is-editing');
  const group = bubble.closest('.message-group');
  if (group) {
    group.classList.add('is-editing');
    setUserMessageActionsVisible(group, true);
  }
  if (chatForm) chatForm.classList.add('is-editing');
  if (sendButton) sendButton.textContent = 'Save';
  if (cancelEditButton) cancelEditButton.hidden = false;
  userInput.value = text;
  userInput.setAttribute('placeholder', 'Edit your message...');
  userInput.focus();
  resizeComposer();
  const end = userInput.value.length;
  userInput.setSelectionRange(end, end);
}

async function saveEditedMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    setVoiceStatus('Message cannot be empty.');
    return;
  }
  if (trimmed.length > MESSAGE_MAX_CHARS) {
    setVoiceStatus('Message is too long. Please shorten it a bit.');
    return;
  }
  if (!editingMessageEl || isSending) return;

  const bubble = editingMessageEl;
  const index = historyIndexForBubble(bubble);
  const entry = index >= 0 ? conversationHistory[index] : null;
  if (!entry || entry.role !== 'user') {
    cancelEditMode();
    setVoiceStatus('Could not save that edit. Please try again.');
    return;
  }
  if (!conversationId || !entry.id) {
    setVoiceStatus('This message is not saved yet, so it cannot be edited.');
    return;
  }

  cancelEditMode();
  stopListening({ silent: true });
  stopSpeaking();

  const contentEl = bubble.querySelector('.message-content');
  if (contentEl) contentEl.textContent = trimmed;
  entry.content = trimmed;

  // Remove later turns using DOM order relative to this bubble (not history index).
  const visible = visibleChatMessages();
  const bubbleIndex = visible.indexOf(bubble);
  visible.forEach((node, nodeIndex) => {
    if (bubbleIndex >= 0 && nodeIndex > bubbleIndex) {
      const group = node.closest('.message-group');
      (group || node).remove();
    }
  });
  conversationHistory.splice(index + 1);

  setLoading(true);
  showTypingIndicator();
  setVoiceStatus('');

  try {
    const response = await apiFetch('/api/messages/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversationId,
        message_id: entry.id,
        content: trimmed,
      }),
    });

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      data = {};
    }

    if (data.conversation_id) {
      conversationId = data.conversation_id;
    }

    if (!response.ok) {
      const error = new Error(
        response.status === 401
          ? 'Please log in to continue.'
          : (data.error || 'Gemini se jawab nahi mil paya. Thodi der baad try karein.')
      );
      error.edited = Boolean(data.edited);
      throw error;
    }
    if (!data.reply) {
      const error = new Error('Gemini se response nahi mila.');
      error.edited = true;
      throw error;
    }

    conversationHistory.push({
      role: 'assistant',
      content: data.reply,
      id: data.assistant_message_id || null,
    });
    hideTypingIndicator();
    appendMessage(data.reply, false, data.assistant_message_id || null);
    refreshConversationList();
  } catch (error) {
    hideTypingIndicator();
    if (!error.edited && conversationId) {
      try {
        await loadConversation(conversationId);
      } catch (_) {
        // Keep the edited bubble visible if reload fails.
      }
      setVoiceStatus(error.message || 'Kuch galat ho gaya. Phir se try karein.');
      userInput.value = trimmed;
      resizeComposer();
    } else {
      appendMessage(error.message || 'Kuch galat ho gaya. Phir se try karein.');
    }
  } finally {
    setLoading(false);
    userInput.focus();
  }
}

// Temporary kill-switch for text-to-image. Set true to re-enable (also enable backend flag).
// Does not remove generateImage /api/image-generation; chat/PDF/image understanding stay on.
const IMAGE_GENERATION_ENABLED = false;
const IMAGE_GENERATION_DISABLED_MESSAGE =
  'Image generation is temporarily unavailable in NovaChat AI. Normal chat and image understanding are still available.';

function isImageGenerationRequest(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 500) return false;
  const t = raw.toLowerCase();

  // Keep conceptual questions on the normal text chat path.
  if (/^(how|what|why|when|where|who|explain|tell me about)\b/.test(t)) return false;
  if (/\bhow\s+(do|does|can|to)\b[\s\S]*\b(image|images|picture|photo)s?\b/.test(t)) {
    return false;
  }

  const explicit = [
    /\bgenerate\s+(an?\s+)?(image|picture|photo|illustration)\b/,
    /\bcreate\s+(an?\s+)?(image|picture|photo|illustration)\b/,
    /\bmake\s+(an?\s+)?(image|picture|photo|illustration)\b/,
    /\bdraw\s+(an?\s+)?(image|picture|photo)\b/,
    /\bcreate\s+a\s+photo\b/,
    /\bgenerate\s+a\s+photo\b/,
  ];
  if (explicit.some((re) => re.test(t))) return true;

  // Soft match: "generate/create/draw a <scene>" without coding keywords.
  if (/^(generate|create|draw)\s+(me\s+)?(a|an)\s+\S+/.test(t)) {
    if (/\b(function|class|code|script|api|endpoint|database|query|algorithm|decorator|variable)\b/.test(t)) {
      return false;
    }
    return true;
  }
  return false;
}

async function generateImage(prompt) {
  if (!IMAGE_GENERATION_ENABLED) {
    throw new Error(IMAGE_GENERATION_DISABLED_MESSAGE);
  }
  const response = await apiFetch('/api/image-generation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });

  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }

  if (response.status === 401) {
    throw new Error('Please log in to continue.');
  }
  const backendError = (data && data.error) ? String(data.error).trim() : '';
  if (!response.ok || !data.ok) {
    throw new Error(
      backendError
      || 'Image generation is temporarily unavailable. Please try again.'
    );
  }
  if (!data.image || !data.image.data) {
    throw new Error(
      backendError
      || 'Image generation did not return an image. Please try again.'
    );
  }
  return data.image;
}

function appendGeneratedImageMessage(image) {
  const message = document.createElement('div');
  message.className = 'message bot-message';
  const content = document.createElement('div');
  content.className = 'message-content';
  const img = document.createElement('img');
  img.className = 'generated-image';
  img.alt = 'Generated image';
  const mime = image.mime_type || image.mimeType || 'image/png';
  img.src = `data:${mime};base64,${image.data}`;
  content.appendChild(img);
  message.appendChild(content);
  chatWindow.appendChild(message);
  scrollChatToBottom();
  return message;
}

async function sendUserMessage(text) {
  if (editingMessageEl) {
    await saveEditedMessage(text);
    return;
  }

  const trimmed = String(text || '').trim();
  const hasAttachments = pendingAttachments.length > 0;
  if ((!trimmed && !hasAttachments) || isSending) return;
  if (!appReady) {
    showAuthScreen('Please log in to send messages.');
    return;
  }
  if (trimmed.length > MESSAGE_MAX_CHARS) {
    setVoiceStatus('Message is too long. Please shorten it a bit.');
    return;
  }

  // Isolated image-generation path — does not use /api/chat/stream.
  if (trimmed && !hasAttachments && isImageGenerationRequest(trimmed)) {
    stopListening({ silent: true });
    stopSpeaking();
    closeAttachMenu();
    hideWelcomeSection();

    appendMessage(trimmed, true);
    userInput.value = '';
    resizeComposer();
    setVoiceStatus('');

    // Feature temporarily disabled: never call generateImage() /api/image-generation.
    if (!IMAGE_GENERATION_ENABLED) {
      appendMessage(IMAGE_GENERATION_DISABLED_MESSAGE);
      conversationHistory.push({ role: 'user', content: trimmed });
      conversationHistory.push({
        role: 'assistant',
        content: IMAGE_GENERATION_DISABLED_MESSAGE,
      });
      userInput.focus();
      return;
    }

    setLoading(true);
    showTypingIndicator();

    try {
      const image = await generateImage(trimmed);
      hideTypingIndicator();
      appendGeneratedImageMessage(image);
      conversationHistory.push({ role: 'user', content: trimmed });
      conversationHistory.push({
        role: 'assistant',
        content: '[Generated image]',
      });
    } catch (error) {
      hideTypingIndicator();
      appendMessage(error.message || 'Image generation failed. Please try again.');
    } finally {
      setLoading(false);
      userInput.focus();
    }
    return;
  }

  stopListening({ silent: true });
  stopSpeaking();
  closeAttachMenu();
  hideWelcomeSection();

  const localAttachmentSnapshot = pendingAttachments.map((item) => ({
    id: item.id,
    name: item.name,
    extension: item.extension,
    size: item.size,
    contentType: item.contentType,
    previewUrl: item.previewUrl,
  }));

  setLoading(true);
  setVoiceStatus('');

  let uploadedMeta = [];
  try {
    if (hasAttachments) {
      uploadedMeta = await uploadPendingAttachments();
    }
  } catch (error) {
    setLoading(false);
    setVoiceStatus(error.message || 'Could not upload attachments. Please try again.');
    userInput.focus();
    return;
  }

  const contentForModel = buildMessageContentWithAttachments(trimmed, uploadedMeta);
  const attachmentIds = uploadedMeta
    .map((item) => item && item.id)
    .filter((id) => Boolean(id));
  const displayText = trimmed || (uploadedMeta.length
    ? `Sent ${uploadedMeta.length} attachment${uploadedMeta.length === 1 ? '' : 's'}`
    : '');

  const userEl = appendMessage(displayText, true, null, localAttachmentSnapshot);
  userInput.value = '';
  clearPendingAttachments({ revoke: false });
  resizeComposer();

  const messagesForRequest = conversationHistory.concat({
    role: 'user',
    content: contentForModel,
  });

  showTypingIndicator();

  let streamUi = null;
  try {
    const data = await fetchGeminiResponseStream(
      messagesForRequest,
      (partial) => {
        if (!streamUi) {
          streamUi = beginStreamingBotMessage();
        }
        updateStreamingBotMessage(streamUi.content, partial);
      },
      attachmentIds
    );
    conversationHistory.push({
      role: 'user',
      content: contentForModel,
      id: data.user_message_id || null,
    });
    conversationHistory.push({
      role: 'assistant',
      content: data.reply,
      id: data.assistant_message_id || null,
    });
    setMessageId(userEl, data.user_message_id);
    if (!streamUi) {
      hideTypingIndicator();
      streamUi = beginStreamingBotMessage();
      updateStreamingBotMessage(streamUi.content, data.reply);
    }
    finalizeStreamingBotMessage(
      streamUi.message,
      streamUi.content,
      data.reply,
      data.assistant_message_id || null
    );
    refreshConversationList();
  } catch (error) {
    if (streamUi && streamUi.message && streamUi.message.parentNode) {
      streamUi.message.remove();
    }
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

if (attachButton) {
  attachButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isSending) return;
    toggleAttachMenu();
  });
}

if (attachMenu) {
  attachMenu.addEventListener('click', (event) => {
    event.stopPropagation();
    const item = event.target.closest('[data-attach-action]');
    if (!item) return;
    const action = item.getAttribute('data-attach-action');
    closeAttachMenu();
    if (action === 'files' && attachFileInput) {
      attachFileInput.click();
    }
  });
}

if (attachFileInput) {
  attachFileInput.addEventListener('change', () => {
    if (attachFileInput.files && attachFileInput.files.length) {
      addPendingFiles(attachFileInput.files);
    }
    attachFileInput.value = '';
  });
}

document.addEventListener('click', (event) => {
  if (!attachMenuOpen) return;
  const wrap = event.target.closest('.attach-wrap');
  if (!wrap) closeAttachMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && attachMenuOpen) {
    event.preventDefault();
    closeAttachMenu();
    if (attachButton) attachButton.focus();
  }
});

if (userInput) {
  userInput.addEventListener('input', resizeComposer);
  userInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && editingMessageEl) {
      event.preventDefault();
      cancelEditMode();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!isSending) chatForm.requestSubmit();
    }
  });
  userInput.addEventListener('paste', (event) => {
    const files = collectClipboardFiles(event.clipboardData);
    if (!files.length) return; // Keep normal text paste behavior.
    event.preventDefault();
    addPendingFiles(files);
    const pastedText = event.clipboardData.getData('text/plain');
    if (pastedText) {
      const start = userInput.selectionStart || 0;
      const end = userInput.selectionEnd || 0;
      const value = userInput.value || '';
      userInput.value = value.slice(0, start) + pastedText + value.slice(end);
      const caret = start + pastedText.length;
      userInput.setSelectionRange(caret, caret);
      resizeComposer();
    }
  });
}

if (cancelEditButton) {
  cancelEditButton.addEventListener('click', () => {
    cancelEditMode();
    userInput.focus();
  });
}

const sidebar = document.getElementById('sidebar');
const historyToggle = document.getElementById('historyToggle');
const historyClose = document.getElementById('historyClose');
const newChatButton = document.getElementById('newChatButton');
const conversationList = document.getElementById('conversationList');
const historyStatus = document.getElementById('historyStatus');
const sidebarOverlay = document.getElementById('sidebarOverlay');

async function apiFetch(path, options = {}) {
  const url = apiUrl(path);
  const response = await fetch(url, Object.assign({ credentials: 'include' }, options));
  if (response.status === 401 && appReady) {
    handleSessionExpired();
  }
  return response;
}

function setAuthError(text) {
  if (!authError) return;
  if (!text) {
    authError.hidden = true;
    authError.textContent = '';
    return;
  }
  authError.hidden = false;
  authError.textContent = text;
}

function applyCurrentUser(user) {
  currentUser = user || null;
  const name = (user && user.name) || 'Account';
  const email = (user && user.email) || '';
  const picture = (user && user.picture) || '';
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  if (accountInitial) {
    accountInitial.textContent = initial;
    accountInitial.hidden = Boolean(picture);
  }
  if (accountRailPicture) {
    if (picture) {
      accountRailPicture.src = picture;
      accountRailPicture.hidden = false;
    } else {
      accountRailPicture.removeAttribute('src');
      accountRailPicture.hidden = true;
    }
  }
  if (sidebarUserName) sidebarUserName.textContent = name;
  if (sidebarUserEmail) sidebarUserEmail.textContent = email;
  if (sidebarUserPicture) {
    if (picture) {
      sidebarUserPicture.src = picture;
      sidebarUserPicture.hidden = false;
    } else {
      sidebarUserPicture.removeAttribute('src');
      sidebarUserPicture.hidden = true;
    }
  }
  if (sidebarUserEmoji) sidebarUserEmoji.hidden = Boolean(picture);
  if (accountButton) accountButton.title = name;
  updateWelcomeGreeting();
}

function showAuthScreen(message) {
  hideAccountMenu();
  closeAccountDialog();
  setSidebarExpanded(false);
  if (appShell) appShell.hidden = true;
  if (authScreen) authScreen.hidden = false;
  if (message) setAuthError(message);
}

function showAppShell() {
  if (authScreen) authScreen.hidden = true;
  if (appShell) appShell.hidden = false;
  setAuthError('');
}

function handleSessionExpired() {
  currentUser = null;
  appReady = false;
  conversationId = null;
  conversationHistory.length = 0;
  setAuthMode('login');
  showAuthScreen('Your session expired. Please log in again.');
}

function hideAccountMenu() {
  if (accountMenu) accountMenu.hidden = true;
  if (accountButton) accountButton.setAttribute('aria-expanded', 'false');
}

function positionAccountMenu(anchor) {
  if (!accountMenu || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const menuWidth = 176;
  let left = rect.right + 8;
  if (left + menuWidth > window.innerWidth - 8) {
    left = Math.max(8, rect.left - menuWidth - 8);
  }
  let top = rect.bottom - 8;
  accountMenu.style.left = `${left}px`;
  accountMenu.style.top = `${Math.max(8, top - 120)}px`;
  accountMenu.hidden = false;
  if (accountButton) accountButton.setAttribute('aria-expanded', 'true');
}

function toggleAccountMenu(anchor) {
  if (!accountMenu) return;
  if (!accountMenu.hidden) {
    hideAccountMenu();
    return;
  }
  positionAccountMenu(anchor || accountButton);
}

function closeAccountDialog() {
  if (accountDialog) accountDialog.hidden = true;
}

function openAccountDialog(title, body) {
  hideAccountMenu();
  if (!accountDialog) return;
  if (accountDialogTitle) accountDialogTitle.textContent = title;
  if (accountDialogBody) accountDialogBody.textContent = body;
  accountDialog.hidden = false;
}

function showProfileDialog() {
  if (!currentUser) return;
  openAccountDialog(
    'Profile',
    `Name: ${currentUser.name}\nEmail: ${currentUser.email}`
  );
}

function showSettingsDialog() {
  openAccountDialog(
    'Settings',
    'Settings will be available in a future update. Voice language can be changed next to the microphone.'
  );
}

async function logoutCurrentUser() {
  hideAccountMenu();
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (_) {
    // Still clear the local session UI.
  }
  currentUser = null;
  appReady = false;
  startNewConversation();
  setAuthMode('login');
  showAuthScreen('');
}

function setupPasswordToggles() {
  document.querySelectorAll('.password-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.getAttribute('data-target'));
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      const label = show ? 'Hide password' : 'Show password';
      button.setAttribute('aria-label', label);
      button.title = label;
      button.classList.toggle('is-visible', show);
    });
  });
}

function setAuthMode(mode) {
  const signup = mode === 'signup';
  if (loginPanel) loginPanel.hidden = signup;
  if (signupPanel) signupPanel.hidden = !signup;
  if (authHeading) authHeading.textContent = signup ? 'Create your account' : 'Welcome back';
  if (authSubtitle) {
    authSubtitle.textContent = signup ? 'Sign up to get started' : 'Login to continue';
  }
  setAuthError('');
}

async function submitAuthForm(url, payload, submitButton) {
  setAuthError('');
  if (submitButton) submitButton.disabled = true;
  try {
    const response = await fetch(apiUrl(url), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setAuthError(data.error || 'Something went wrong. Please try again.');
      return;
    }
    applyCurrentUser(data.user);
    await enterAuthenticatedApp();
  } catch (_) {
    setAuthError('Network error. Check your connection and try again.');
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function setupAuthUi() {
  setupPasswordToggles();
  const googleLoginButton = document.getElementById('googleLoginButton');
  if (googleLoginButton) {
    googleLoginButton.setAttribute('href', googleOAuthStartUrl());
  }
  const params = new URLSearchParams(window.location.search);
  const authErrorParam = params.get('auth_error');
  if (authErrorParam) {
    setAuthMode('login');
    setAuthError(authErrorParam);
    params.delete('auth_error');
    const next = params.toString();
    const clean = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash || ''}`;
    window.history.replaceState({}, '', clean);
  }

  if (showSignupButton) {
    showSignupButton.addEventListener('click', () => setAuthMode('signup'));
  }
  if (showLoginButton) {
    showLoginButton.addEventListener('click', () => setAuthMode('login'));
  }
  if (loginForm) {
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitAuthForm('/api/auth/login', {
        email: (document.getElementById('loginEmail').value || '').trim().toLowerCase(),
        password: document.getElementById('loginPassword').value,
      }, document.getElementById('loginSubmit'));
    });
  }
  if (signupForm) {
    signupForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitAuthForm('/api/auth/signup', {
        name: document.getElementById('signupName').value,
        email: (document.getElementById('signupEmail').value || '').trim().toLowerCase(),
        password: document.getElementById('signupPassword').value,
        confirm_password: document.getElementById('signupConfirm').value,
      }, document.getElementById('signupSubmit'));
    });
  }

  if (accountButton) {
    accountButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleAccountMenu(accountButton);
    });
  }
  if (accountFooterButton) {
    accountFooterButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleAccountMenu(accountFooterButton);
    });
  }
  if (accountMenu) {
    accountMenu.addEventListener('click', (event) => {
      event.stopPropagation();
      const action = event.target && event.target.getAttribute('data-action');
      if (action === 'profile') showProfileDialog();
      else if (action === 'settings') showSettingsDialog();
      else if (action === 'logout') logoutCurrentUser();
    });
  }
  if (settingsButton) settingsButton.addEventListener('click', showSettingsDialog);
  if (logoutButton) logoutButton.addEventListener('click', logoutCurrentUser);
  if (accountDialogClose) accountDialogClose.addEventListener('click', closeAccountDialog);
  if (accountDialog) {
    accountDialog.addEventListener('click', (event) => {
      if (event.target === accountDialog) closeAccountDialog();
    });
  }
  document.addEventListener('click', () => hideAccountMenu());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideAccountMenu();
      closeAccountDialog();
    }
  });
}

async function enterAuthenticatedApp() {
  showAppShell();
  appReady = true;
  setupSidebar();
  startNewConversation();
  await refreshConversationList();
}

async function bootApp() {
  try {
    const response = await fetch(apiUrl('/api/auth/me'), { credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    if (data.authenticated && data.user) {
      applyCurrentUser(data.user);
      await enterAuthenticatedApp();
      return;
    }
  } catch (_) {
    setAuthError('Could not reach the server. Refresh and try again.');
  }
  showAuthScreen('');
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function setHistoryStatus(text) {
  if (!historyStatus) return;
  if (!text) {
    historyStatus.hidden = true;
    historyStatus.textContent = '';
    return;
  }
  historyStatus.hidden = false;
  historyStatus.textContent = text;
}

function setSidebarExpanded(expanded, mode = sidebarMode) {
  if (!sidebar) return;
  sidebar.classList.toggle('is-expanded', expanded);
  if (!expanded) {
    sidebarMode = null;
  } else {
    sidebarMode = mode || 'history';
  }
  if (historyToggle) {
    historyToggle.classList.toggle('is-active', expanded && sidebarMode === 'history');
    historyToggle.setAttribute('aria-expanded', expanded && sidebarMode === 'history' ? 'true' : 'false');
  }
  if (searchToggle) {
    searchToggle.classList.toggle('is-active', expanded && sidebarMode === 'search');
    searchToggle.setAttribute('aria-pressed', expanded && sidebarMode === 'search' ? 'true' : 'false');
  }
  if (historySearchWrap) {
    historySearchWrap.hidden = !(expanded && sidebarMode === 'search');
  }
  if (sidebarPanelTitle) {
    sidebarPanelTitle.textContent = sidebarMode === 'search' ? 'Search' : 'History';
  }
  if (sidebarOverlay) {
    if (expanded && isMobileLayout()) {
      sidebarOverlay.hidden = false;
    } else {
      sidebarOverlay.hidden = true;
    }
  }
}

function openSidebarMode(mode) {
  const expanded = sidebar && sidebar.classList.contains('is-expanded');
  if (expanded && sidebarMode === mode) {
    setSidebarExpanded(false);
    return;
  }
  setSidebarExpanded(true, mode);
  if (mode === 'search' && historySearchInput) {
    historySearchInput.focus();
  }
  refreshConversationList();
}

function clearChatMessages() {
  chatWindow.querySelectorAll('.message-group').forEach((el) => el.remove());
  chatWindow.querySelectorAll('.message').forEach((el) => el.remove());
}

function startNewConversation() {
  cancelEditMode();
  conversationId = null;
  conversationHistory.length = 0;
  stopSpeaking();
  hideTypingIndicator();
  clearChatMessages();
  showWelcomeSection();
  highlightActiveConversation();
  userInput.focus();
}

function highlightActiveConversation() {
  if (!conversationList) return;
  conversationList.querySelectorAll('.conversation-item').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.id === conversationId);
  });
}

function renderConversationList(conversations) {
  if (!conversationList) return;
  conversationList.innerHTML = '';

  if (!conversations.length) {
    setHistoryStatus(
      historySearchInput && historySearchInput.value.trim() && sidebarMode === 'search'
        ? 'No conversations matched your search.'
        : 'No saved conversations yet.'
    );
    return;
  }

  setHistoryStatus('');
  conversations.forEach((conv) => {
    const row = document.createElement('div');
    row.className = 'conversation-item';
    row.dataset.id = conv.id;
    if (conv.id === conversationId) row.classList.add('is-active');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'conversation-open';
    const title = document.createElement('span');
    title.className = 'conversation-title';
    title.textContent = conv.title || 'Conversation';
    openBtn.appendChild(title);
    openBtn.addEventListener('click', () => loadConversation(conv.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'conversation-delete';
    delBtn.setAttribute('aria-label', 'Delete conversation');
    delBtn.title = 'Delete';
    delBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v11a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7H4a1 1 0 1 1 0-2h4V4Zm2 1v1h2V5h-2ZM7 7v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7H7Zm3 3a1 1 0 0 1 2 0v6a1 1 0 1 1-2 0v-6Zm4 0a1 1 0 0 1 2 0v6a1 1 0 1 1-2 0v-6Z"/></svg>';
    delBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteConversation(conv.id, conv.title);
    });

    row.appendChild(openBtn);
    row.appendChild(delBtn);
    conversationList.appendChild(row);
  });
}

async function refreshConversationList() {
  if (!conversationList) return;
  try {
    const query = (sidebarMode === 'search' && historySearchInput)
      ? historySearchInput.value.trim()
      : '';
    const url = query
      ? `/api/conversations?q=${encodeURIComponent(query)}`
      : '/api/conversations';
    const response = await apiFetch(url);
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      setHistoryStatus('Please log in to see your history.');
      return;
    }
    if (!response.ok) {
      setHistoryStatus(data.error || 'Could not load chat history.');
      return;
    }
    renderConversationList(data.conversations || []);
  } catch (_) {
    setHistoryStatus('Could not load chat history.');
  }
}

async function loadConversation(id, { force = false } = {}) {
  if (!id || (isSending && !force)) return;
  cancelEditMode();
  try {
    const response = await apiFetch(`/api/conversations/${id}/messages`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setHistoryStatus(data.error || 'Could not open that conversation.');
      return;
    }

    conversationId = data.conversation_id || id;
    conversationHistory.length = 0;
    stopSpeaking();
    hideTypingIndicator();
    clearChatMessages();

    const messages = data.messages || [];
    if (!messages.length) {
      showWelcomeSection();
    } else {
      hideWelcomeSection();
      messages.forEach((msg) => {
        const role = (msg.role || 'user').toLowerCase();
        const content = msg.content || '';
        const isUser = role === 'user';
        conversationHistory.push({
          role: isUser ? 'user' : 'assistant',
          content,
          id: msg.id || null,
        });
        appendMessage(content, isUser, msg.id || null);
      });
    }

    highlightActiveConversation();
    if (isMobileLayout()) setSidebarExpanded(false);
  } catch (_) {
    setHistoryStatus('Could not open that conversation.');
  }
}

async function deleteConversation(id, title) {
  if (!id) return;
  const label = title || 'this conversation';
  const confirmed = window.confirm(`Delete "${label}"? This cannot be undone.`);
  if (!confirmed) return;

  try {
    const response = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setHistoryStatus(data.error || 'Could not delete that conversation.');
      return;
    }
    if (conversationId === id) {
      startNewConversation();
    }
    await refreshConversationList();
  } catch (_) {
    setHistoryStatus('Could not delete that conversation.');
  }
}

function setupSidebar() {
  if (sidebarInitialized) return;
  sidebarInitialized = true;

  if (historyToggle) {
    historyToggle.addEventListener('click', () => openSidebarMode('history'));
  }
  if (searchToggle) {
    searchToggle.addEventListener('click', () => openSidebarMode('search'));
  }
  if (historyClose) {
    historyClose.addEventListener('click', () => setSidebarExpanded(false));
  }
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => setSidebarExpanded(false));
  }
  const startFreshChat = () => {
    startNewConversation();
    if (isMobileLayout()) setSidebarExpanded(false);
  };
  if (newChatButton) {
    newChatButton.addEventListener('click', startFreshChat);
  }
  if (newChatPanelButton) {
    newChatPanelButton.addEventListener('click', startFreshChat);
  }
  if (historySearchInput) {
    historySearchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => refreshConversationList(), 250);
    });
    historySearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        refreshConversationList();
      }
    });
  }
}

setupVoiceControls();
setupWelcomeSuggestions();
setupAuthUi();
bootApp();
