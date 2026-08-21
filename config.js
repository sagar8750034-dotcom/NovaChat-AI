/**
 * Public frontend config only — never put secrets here.
 *
 * Local development (Flask serves index.html on the same origin):
 *   leave as "" so API calls stay relative to http://127.0.0.1:5002
 *
 * Netlify production:
 *   set to your existing Render backend URL, e.g.
 *   "https://YOUR-SERVICE.onrender.com"
 *   (no trailing slash)
 *
 * Netlify can also inject this at build time via the BACKEND_URL env var
 * (see netlify.toml). Prefer that over committing a production URL.
 */
window.NOVACHAT_API_BASE_URL = window.NOVACHAT_API_BASE_URL || "";
