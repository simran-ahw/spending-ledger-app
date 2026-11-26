# Spending Ledger

An installable phone app that records spending automatically and turns it into daily habits that hit a savings target.

- **Recording:** receipt photos read by Claude (with split receipts), manual entry, pasted bank alerts, and **Android bank/card notifications sent straight to the app** through MacroDroid.
- **Insights:** yesterday summary, month-end projection, daily spending vs allowance, day and month pie charts, running totals, weekly check-in with category streaks, monthly report with five insights, month-over-month and year-over-year comparisons, 12-month trends, Claude coaching tips.
- **Habits:** monthly limits per category (with suggestions), warnings at 80% and 100%, a **daily app streak** with badges.
- **Notifications** (even when the app is closed): each purchase from your phone, limit warnings, an evening summary with a streak reminder, and a Monday weekly check-in.

## How it fits together

| Part | Where it runs | What it does |
| --- | --- | --- |
| `web/` | GitHub Pages (free) | The app: works offline, installs from Chrome, receives push notifications |
| `supabase/migrations/` | Supabase Postgres (free plan) | Tables, per-user privacy rules, hourly job, active-user reports |
| `supabase/functions/ai` | Supabase Edge Function | Receipt reading, pasted alerts, coaching tips (calls Claude) |
| `supabase/functions/ingest` | Supabase Edge Function | Your phone's private link: turns each bank notification into an expense |
| `supabase/functions/cron` | Supabase Edge Function, hourly | Recurring expenses, daily summary + streak reminder, weekly check-in |
| `.github/workflows/` | GitHub Actions | Deploys everything when you push to `main` |

Every table uses row-level security: each signed-in person can only ever read or change their own rows.

---

## One-time setup (about 30 minutes)

You'll need the private values file Claude gave you (`setup-values.txt`): it holds your push-notification keys and a cron secret.

### 1. Supabase project
1. At [supabase.com](https://supabase.com) create a project (e.g. *spending-ledger*, region *Canada (Central)*). Save the **database password**.
2. Note these:
   - **Project ref**: Project Settings → General (e.g. `abcdxyz…`).
   - **Project URL**: `https://<project-ref>.supabase.co`.
   - **Publishable key**: Project Settings → API Keys (starts `sb_publishable_`).
3. Create an **access token**: Account (top-right avatar) → Access Tokens → Generate new token.

### 2. Claude API key
At [console.anthropic.com](https://console.anthropic.com) create an API key and add a little credit. Each receipt or alert is one short request.

### 3. GitHub repository settings
In this repository: **Settings → Pages** → *Build and deployment* → Source: **GitHub Actions**.

Then **Settings → Secrets and variables → Actions**:

**Variables** tab:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | the `sb_publishable_…` key |
| `SUPABASE_PROJECT_REF` | the project ref |
| `VAPID_PUBLIC_KEY` | from `setup-values.txt` |
| `VAPID_CONTACT` | `mailto:you@example.com` (your email) |
| `APP_ORIGIN` | `https://<your-github-username>.github.io` |

**Secrets** tab:

| Name | Value |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | the access token from step 1.3 |
| `SUPABASE_DB_PASSWORD` | the database password |
| `ANTHROPIC_API_KEY` | the Claude API key |
| `VAPID_PRIVATE_KEY` | from `setup-values.txt` (the whole `{…}` line) |
| `CRON_SECRET` | from `setup-values.txt` |

### 4. Deploy
**Actions** tab → run **Deploy database and server functions to Supabase**, then **Deploy app to GitHub Pages** (each has a *Run workflow* button). After that, every push to `main` deploys automatically.

Your app's address: `https://<your-github-username>.github.io/spending-ledger-app/`

### 5. Turn on the hourly job
Supabase → **SQL Editor** → run the two `vault.create_secret` lines from `setup-values.txt` (put your project ref in the URL). This lets the hourly job call the `cron` function.

### 6. Google sign-in
1. [Google Cloud console](https://console.cloud.google.com) → create a project → **APIs & Services → OAuth consent screen**: External, app name *Spending Ledger*, your email. While testing, add yourself under *Test users*.
2. **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized JavaScript origins: `https://<your-github-username>.github.io`
   - Authorized redirect URIs: `https://<project-ref>.supabase.co/auth/v1/callback`
3. Copy the **Client ID** and **Client secret** into Supabase → **Authentication → Sign In / Providers → Google**, and enable it.
4. Supabase → **Authentication → URL Configuration**: Site URL = your app's address; add the same address under *Redirect URLs*.

### 7. On your phone
1. Open the app's address in **Chrome**, sign in with Google, tap **Install app** (or ⋮ → *Install app*).
2. **Budget → Notifications → Turn on notifications**. A test notification should arrive.
3. **Budget → Connect your phone**: copy your private link and follow the MacroDroid steps shown there.
4. **Budget → Import from your old tracker**: paste the CSV from the old tracker's *Copy CSV* button.

---

## Daily and monthly active users
Supabase → SQL Editor:

```sql
select * from daily_active_users limit 30;
select * from monthly_active_users;
```

A user counts as active on a day when they open the app (the same record that drives their streak).

## Costs
- GitHub Pages and the Supabase free plan: $0 for personal use.
- Claude API: receipts use `claude-sonnet-5-5`, alerts and tips use `claude-haiku-5-5` (change with the `CLAUDE_VISION_MODEL` / `CLAUDE_FAST_MODEL` function secrets). Each person is capped at `AI_DAILY_CAP` (default 150) Claude calls a day.

## Troubleshooting
- **Sign-in returns to the sign-in screen:** check step 6.4 (Site URL / Redirect URLs) and that you're a test user.
- **No notifications:** Budget → Notifications should say they're on. On Android, also allow notifications for Chrome / the installed app in system settings.
- **Phone purchases don't appear:** Budget → *Recently received* shows what arrived. Nothing there → check the MacroDroid macro and its notification access. "Not a purchase" → the alert wasn't a spend (codes, deposits and refunds are skipped).
- **No evening summary:** check step 5, then Supabase → Integrations → Cron → job history.

## Develop locally
```bash
cp supabase/functions/_shared/logic.js web/logic.js
cp web/config.example.js web/config.js   # fill in your values
python3 -m http.server -d web 8000
node --test tests/                      # logic and Claude-client tests
```
