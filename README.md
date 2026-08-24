# NovaChat AI

A Flask chat app with a Gemini-powered backend, an HTML/CSS/JS frontend, and Neon PostgreSQL for conversation storage.

## Prerequisites

- Python 3.10+
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
- A Neon PostgreSQL database and `DATABASE_URL` from [Neon Console](https://console.neon.tech)

## Run locally

1. Open a terminal in the project folder.

2. Create a `.env` file from the example:

   ```powershell
   copy .env.example .env
   ```

   Then edit `.env` and set:

   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   GEMINI_MODEL=gemini-flash-lite-latest
   DATABASE_URL=postgresql://USER:PASSWORD@HOST/dbname?sslmode=require
   SECRET_KEY=change-this-to-a-long-random-string
   GOOGLE_CLIENT_ID=your_google_client_id
   GOOGLE_CLIENT_SECRET=your_google_client_secret
   GOOGLE_REDIRECT_URI=http://127.0.0.1:5002/auth/google/callback
   TTS_API_KEY=your_tts_api_key_here
   ```

3. Install dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

4. Apply database migrations (creates `users`, `conversations`, and `messages` tables, and adds conversation ownership):

   ```powershell
   alembic upgrade head
   ```

5. Start the backend (this also serves the UI):

   ```powershell
   python app.py
   ```

6. Open the app in your browser:

   **http://127.0.0.1:5002/**

7. Verify the Neon connection:

   **http://127.0.0.1:5002/api/health**

   You should see `"database": "connected"`.

Do not open `index.html` as a file. The chat UI must run through the Flask server so messages can reach Gemini.

You can sign in with email and password, or with Google. Accounts that share the same verified email are linked, so history stays in one place.

## Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/) create (or select) a project.
2. Configure the OAuth consent screen (External is fine for testing).
3. Create credentials → **OAuth client ID** → **Web application**.
4. Add authorized JavaScript origins and redirect URIs:

   - Local origin: `http://127.0.0.1:5002`
   - Local redirect: `http://127.0.0.1:5002/auth/google/callback`
   - Render origin: `https://YOUR-SERVICE.onrender.com`
   - Render redirect: `https://YOUR-SERVICE.onrender.com/auth/google/callback`

5. Copy the client ID and secret into `.env`. `GOOGLE_REDIRECT_URI` must match one of the redirect URIs exactly.

6. Run `alembic upgrade head` if you have not applied the Google identity migration yet.

### Split hosting (Netlify frontend + Render API)

If the UI is on Netlify and the API stays on Render:

1. Netlify env `API_BASE_URL` = your Render origin (e.g. `https://YOUR-SERVICE.onrender.com`) — public URL only, no secrets.
   (`BACKEND_URL` is still accepted as a fallback name.)
2. Render env:
   - `FRONTEND_ORIGIN` = your Netlify origin (e.g. `https://YOUR-SITE.netlify.app`)
   - `CORS_ORIGINS` = same Netlify origin (comma-separated if you have preview URLs too)
   - `SESSION_COOKIE_SAMESITE=None`
   - `SESSION_COOKIE_SECURE=true`
   - `GOOGLE_REDIRECT_URI` remains the **Render** callback: `https://YOUR-SERVICE.onrender.com/auth/google/callback`
3. In Google Cloud Console also add the Netlify origin under **Authorized JavaScript origins**.

## Stop the server

In the terminal running `python app.py`, press `Ctrl + C`.
