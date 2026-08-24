/**
 * Public frontend config only — never put secrets here.
 *
 * Local development (Flask serves this UI on the same origin):
 *   leave as "" so API/OAuth calls stay on http://127.0.0.1:5002
 *
 * Netlify production:
 *   Prefer setting Netlify env NOVACHAT_API_BASE_URL or API_BASE_URL to:
 *   "https://novachat-ai.onrender.com"
 *   script.js also auto-detects *.netlify.app and uses that Render URL.
 */
window.NOVACHAT_API_BASE_URL = window.NOVACHAT_API_BASE_URL || "";
window.API_BASE_URL = window.API_BASE_URL || window.NOVACHAT_API_BASE_URL || "";
