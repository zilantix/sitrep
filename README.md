# SITREP — Project Command Center

A Kanban board for a cloud architect running multiple projects. Log quick updates and raw meeting notes per project, then generate:

- **SITREP** per project — summary, what changed since last brief, obstacles, recommended actions, questions for the team, decisions needed
- **Meeting prep** across all active projects — program overview, per-project status lines, cross-cutting risks, and a suggested agenda

Stack: Cloudflare Workers + D1 (SQLite) + static frontend. Brief generation runs on **Workers AI** by default (Cloudflare's own models — no external API key, includes a free daily allocation), and can be switched to the Anthropic API for higher-quality briefs by changing one config line.

## Prerequisites

- Node.js 18+ and npm
- A free Cloudflare account — https://dash.cloudflare.com/sign-up
- (Only if you switch PROVIDER to "anthropic") an Anthropic API key — https://console.anthropic.com

## Choosing the AI provider

`wrangler.toml` → `[vars]` → `PROVIDER`:

- `"workers-ai"` (default) — uses Llama 3.3 70B on Cloudflare. No key, no external calls, free daily allocation on the Workers Free plan (paid usage beyond it is still cheap). Briefs are good; occasionally you may need to hit regenerate if the model returns malformed output.
- `"anthropic"` — uses Claude via the Anthropic API. Noticeably better synthesis and instruction-following for this kind of multi-source summarization. Requires step 4 below.

## Setup (about 10 minutes)

**1. Install dependencies and log in to Cloudflare**

```bash
npm install
npx wrangler login        # opens a browser to authorize
```

**2. Create the D1 database**

```bash
npx wrangler d1 create sitrep-db
```

The command prints a `database_id`. Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_DATABASE_ID` with it.

**3. Apply the schema**

```bash
npm run db:remote     # production database
npm run db:local      # local copy, used by `wrangler dev`
```

**4. (Skip if using Workers AI, the default) Set your Anthropic API key as a secret**

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# paste the key when prompted — it is stored encrypted, never in code
```

For local development, also create a file named `.dev.vars` in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

(`.dev.vars` is gitignored — never commit it.)

**5. Run locally**

```bash
npm run dev
```

Open http://localhost:8787. Local mode uses a local SQLite file, so you can experiment freely without touching production data.

**6. Deploy**

```bash
npm run deploy
```

Wrangler prints your URL, e.g. `https://sitrep.<your-subdomain>.workers.dev`. Done.

## Lock it down with Cloudflare Access (strongly recommended)

Your project data will live behind this URL, so don't leave it public. Cloudflare Access (free for up to 50 users) puts a login wall in front of the entire app:

1. Cloudflare dashboard → **Zero Trust** → complete the one-time setup (pick the free plan).
2. **Access → Applications → Add an application → Self-hosted.**
3. Application domain: your `*.workers.dev` hostname (or a custom domain if you attach one).
4. Add a policy: **Allow** → Include → **Emails** → your email address.
5. Save. Now visiting the app requires a one-time PIN sent to your email (or SSO if you configure Google/GitHub as an identity provider).

This protects both the UI and the API with zero code changes.

## Optional: auto-generate meeting prep every morning

Uncomment the `[triggers]` block at the bottom of `wrangler.toml` and adjust the cron (times are UTC — `30 11 * * 1-5` is 6:30 AM Central on weekdays), then redeploy. The Worker's `scheduled` handler generates a fresh program-wide prep so it's already waiting when you click **Generate meeting prep** (it shows the latest one first).

## Daily workflow

1. Something happens on a project → open its card → **Log an update** (one or two sentences is plenty).
2. After a meeting → paste your raw notes into **Meeting notes** with the meeting date.
3. Before a status meeting → click the project's **Generate SITREP**, or the header's **Generate meeting prep** for the whole portfolio. Each SITREP includes a "Since last brief" delta, so you always know where you stopped last time.
4. Cards show when the last SITREP was generated; the timestamp turns amber after 7 days as a nudge.

## A note on sensitive data

Brief generation sends project text to the Anthropic API. If your notes may contain CUI/FOUO or agency-internal specifics, sanitize before pasting (project codenames, no client identifiers) — or treat this strictly as a personal organizer with generic content. For an official-side version, the same design ports to AWS GovCloud with Bedrock replacing the external API call.

## Configuration

- **Model**: set in `wrangler.toml` under `[vars]` (`MODEL = "claude-sonnet-4-6"`). Swap to a different Claude model string any time.
- **Statuses**: `planned / active / blocked / complete`, enforced in `schema.sql` and the Worker. Add a status by updating both plus the `STATUSES` array in `public/index.html`.

## API reference (all JSON)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects` | List projects with counts + last brief time |
| POST | `/api/projects` | Create `{name, description?, stakeholders?}` |
| GET | `/api/projects/:id` | Project with updates, notes, briefs |
| PATCH | `/api/projects/:id` | Update fields / status |
| DELETE | `/api/projects/:id` | Delete project (cascades) |
| POST | `/api/projects/:id/updates` | Add `{content}` |
| POST | `/api/projects/:id/notes` | Add `{content, meeting_date?}` |
| DELETE | `/api/updates/:id`, `/api/notes/:id` | Remove an entry |
| POST | `/api/projects/:id/brief` | Generate a SITREP |
| POST | `/api/meeting-prep` | Generate program-wide prep |
| GET | `/api/meeting-prep` | Most recent prep |
