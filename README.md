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
   ```

3. Install dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

4. Apply database migrations (creates `conversations` and `messages` tables):

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

## Stop the server

In the terminal running `python app.py`, press `Ctrl + C`.
