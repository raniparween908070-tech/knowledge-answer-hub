# Knowledge Answer Hub

AI-powered, multilingual question-and-answer website. Static pages in `public/`, an Express API wrapped as a Netlify Function (`netlify/functions/api.js` → `server.js`), and the Google Gemini API (`@google/genai`). The contact form uses **Netlify Forms**.

## Project structure

```text
knowledge-answer-hub/
├── netlify.toml            # build, function, redirect and security-header config
├── package.json
├── .nvmrc                  # Node 22
├── .env.example            # local development only
├── server.js               # Express app (/api/ask, /api/health) + local static server
├── netlify/functions/api.js
└── public/                 # index, about, contact, privacy, disclaimer, terms, style.css, app.js
```

## Deploy to Netlify without GitHub (Netlify CLI)

Do **not** use drag-and-drop: it does not reliably build or deploy functions.

1. Install Node 22 and the CLI: `npm install -g netlify-cli`, then `netlify login`.
2. In this folder run `npm install` (this also creates `package-lock.json`; keep it).
3. Create/link a site: `netlify init --manual` (or `netlify link` if the site exists).
4. In the Netlify dashboard, open **Site configuration → Environment variables** and add:
   - `GEMINI_API_KEY` = your key. Mark it **Contains secret values** and make sure its scopes include **Functions** (and Runtime).
   - `GEMINI_MODEL` = `gemini-3.1-flash-lite`
   - `SITE_NAME` = `Knowledge Answer Hub`
   - Optional `GEMINI_TIMEOUT_MS` (see Timeouts).
   Never put the key in any file, in the ZIP, or in front-end code.
5. In **Site configuration → Forms**, confirm form detection is enabled.
6. Draft deploy and test: `netlify deploy --build` → open the draft URL, ask a question, open `/api/health`, submit the contact form.
7. Production deploy: `netlify deploy --build --prod`.
8. Add notifications for the contact form under **Forms → Form notifications** (email).

Environment variable changes only apply after a new deploy.

## Timeouts

Netlify synchronous functions default to 10 seconds. `netlify.toml` requests 26 seconds, which only takes effect once Netlify activates it for your site (plan-dependent; ask Netlify support). The app stops waiting for Gemini after `GEMINI_TIMEOUT_MS` (default 8000 ms, safe for the 10 s limit) and shows a friendly message. If Netlify enables 26 s for your site, set `GEMINI_TIMEOUT_MS=23000` and redeploy.

## After the first deploy: replace `example.com`

Replace `https://example.com` with your real site URL (Netlify URL or custom domain) in the lines listed in `DOMAIN-UPDATE.txt`, then redeploy.

## Troubleshooting (first deploy)

- **Build/function error such as "Dynamic require is not supported" or "Cannot find module"**: open the deploy log and Functions logs in Netlify, and send me the exact error. `netlify.toml` already lists all runtime packages in `external_node_modules`.
- **Questions return "temporarily unavailable"**: check that `GEMINI_API_KEY` exists in Netlify with the **Functions** scope, then redeploy (variable changes only apply to new deploys). Details are in the function logs, never shown to visitors.
- **Questions return "took too long"**: Netlify is still using the 10 s limit. Ask Netlify support to activate the 26 s limit, then set `GEMINI_TIMEOUT_MS=23000` and redeploy.
- **Contact form shows an error**: make sure form detection is enabled and the deploy finished; the form `contact` must appear under **Forms**. Always test it once on the draft URL.

## Local development

`cp .env.example .env`, add your key, `npm install`, `npm start`, open http://localhost:3000. Netlify Forms only works on Netlify, so the contact form shows an error locally.

## Notes

- The in-app rate limit is kept in memory per function instance; it is a basic safeguard, not a hard cap. Set quota/spending limits in Google AI Studio / Netlify.
- Visitors only see generic error messages; details are written to the Netlify function logs.
