# FlowForge — Full-stack Mini Make

A self-hostable, multi-user educational automation platform. This version includes a Node.js/Express backend, PostgreSQL persistence, Google OAuth 2.0, encrypted Google tokens, real inbound webhooks, a workflow executor, Google Sheets row insertion, HTTP actions, filters, and execution logs.

> **Important:** This is a functional starter/MVP, not a production-equivalent Make.com clone. Webhook executions currently run synchronously in the API process. For production/high-volume use, add a durable queue/worker, stronger observability, quotas, and security review.

## Features

- Multi-user Google sign-in; users only access their own workflows and Google connection.
- OAuth offline access; refresh tokens are encrypted at rest using AES-256-GCM.
- List spreadsheets visible to the connected account and inspect tab names.
- Create, update, activate, pause, and delete workflows.
- Unique secret webhook URL per workflow: `POST /hooks/:token`.
- Immediate workflow execution on inbound webhook requests.
- Google Sheets `values.append` integration that writes a new row.
- Filter, HTTP request, formatter/set-variable, router pass-through, and capped delay nodes.
- Per-run and per-step status, input/output, timestamps, and error logging.
- Minimal browser console at `/`; previous visual prototype retained at `/demo.html`.

## Requirements

- Node.js 20 or newer
- Docker Desktop (or PostgreSQL 14+)
- A Google Cloud project with Google Sheets API and Google Drive API enabled
- Google OAuth web application credentials

## Quick start (local)

1. Extract the ZIP and open a terminal in the project directory.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start PostgreSQL:

   ```bash
   docker compose up -d postgres
   ```

4. Copy `.env.example` to `.env`. Generate secrets, for example:

   ```bash
   # macOS/Linux: output a 32-byte hex key and a session secret
   openssl rand -hex 32
   openssl rand -base64 48
   ```

   Put the first output in `TOKEN_ENCRYPTION_KEY` (exactly 64 hex characters) and the second in `SESSION_SECRET`. Keep `.env` private and out of source control.

5. Configure Google OAuth (see below), then fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL`.
6. Generate Prisma Client and create the database schema:

   ```bash
   npm run db:generate
   npm run db:deploy
   ```

   For a migration-based workflow, use `npm run db:migrate -- --name init` instead of `db:push`; commit the generated migration folder and use `npm run db:deploy` in production.

7. Start the app:

   ```bash
   npm run dev
   ```

8. Open `http://localhost:4000`, choose **Continue with Google**, approve access, then create a Sheets automation.

## Google Cloud OAuth setup

1. Open Google Cloud Console and create/select a project.
2. Enable **Google Sheets API** and **Google Drive API**.
3. Configure the OAuth consent screen. Add your own Google account as a test user while the app is in Testing mode.
4. Create an OAuth Client ID of type **Web application**.
5. Add this Authorized redirect URI exactly:

   `http://localhost:4000/auth/google/callback`

6. Copy the client ID and client secret into `.env`.
7. Keep the requested scopes in `server/src/google.js`. The app requests OpenID/profile/email, Sheets access, and Drive metadata access so it can list spreadsheets and append to the user's selected sheet.

For production, use HTTPS, a real domain, matching authorized redirect URI, a verified consent screen where required, and secure secret storage. Google may require app verification depending on audience/scopes.

## First real automation

1. Sign in at `/`.
2. Create a Google spreadsheet and add a header row, for example: `Name | Phone | Email | City`.
3. Select that spreadsheet in FlowForge.
4. Set range to `Sheet1!A:Z` (change `Sheet1` to the exact tab name).
5. Keep/edit the mapping, one value per line:

   ```text
   {{trigger.name}}
   {{trigger.phone}}
   {{trigger.email}}
   {{trigger.city}}
   ```

6. Click **Create workflow**. It is activated immediately and the UI shows its webhook URL.
7. Send a POST request to that URL:

   ```bash
   curl -X POST 'http://localhost:4000/hooks/PASTE_WEBHOOK_TOKEN' \
     -H 'Content-Type: application/json' \
     -d '{"name":"Gokul","phone":"9876543210","email":"gokul@example.com","city":"Chennai"}'
   ```

8. The response includes the execution ID and status. Check the Google Sheet for the appended row.

The webhook is public by design, so its long random URL acts as a bearer secret. Do not publish it. Use HTTPS in production. Add your own request signature or IP allowlist for sensitive workloads.

## Workflow definition format

Workflows are saved as JSON with `nodes` and `edges` (React Flow-compatible shape). Example:

```json
{
  "nodes": [
    {"id":"trigger","type":"webhook","data":{"type":"webhook"}},
    {"id":"filter","type":"filter","data":{"config":{"field":"city","operator":"equals","value":"Chennai"}}},
    {"id":"sheets","type":"googleSheets","data":{"config":{"spreadsheetId":"GOOGLE_SHEET_ID","range":"Sheet1!A:Z","mapping":[{"value":"{{trigger.name}}"},{"value":"{{trigger.phone}}"}]}}}
  ],
  "edges": [
    {"id":"e1","source":"trigger","target":"filter"},
    {"id":"e2","source":"filter","target":"sheets","sourceHandle":"true"}
  ]
}
```

Supported node types:

| Node type | Configuration |
|---|---|
| `webhook` | Trigger node; receives the request JSON as `trigger` |
| `filter` | `field`, `operator`, `value`; operators: `equals`, `notEquals`, `contains`, `notContains`, `isEmpty`, `greaterThan`, `lessThan`. Branch edges can use `sourceHandle: "true"` or `"false"` |
| `googleSheets` | `spreadsheetId`, `range`, `mapping` array, optional `valueInputOption` |
| `http` | `url`, `method`, optional `headers`, `body`; production requires HTTPS |
| `formatter` / `setVariable` | `output` or `value` object/string; supports `{{trigger.field}}` substitutions |
| `router` | Pass-through fan-out node; connect it to multiple downstream nodes |
| `delay` | `milliseconds` (capped at 30 seconds in this starter) |

Mapping expressions support paths such as `{{trigger.email}}`, `{{steps.nodeId.updatedRange}}`, and `{{previous.status}}`. Values are interpolated as strings in this starter.

## API overview

All `/api/*` routes require a Google-authenticated session cookie. Webhooks are public and token-addressed.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/auth/google` | Begin Google OAuth |
| GET | `/auth/google/callback` | OAuth callback |
| POST | `/auth/logout` | End session |
| GET | `/api/me` | Current user and Google connection status |
| GET | `/api/google/spreadsheets` | List accessible spreadsheets |
| GET | `/api/google/spreadsheets/:id/tabs` | List tabs in a spreadsheet |
| GET/POST | `/api/workflows` | List/create workflows |
| GET/PUT/DELETE | `/api/workflows/:id` | Read/update/delete an owned workflow |
| POST | `/api/workflows/:id/test` | Run workflow with supplied JSON (authenticated) |
| GET | `/api/workflows/:id/executions` | Read execution and step history |
| POST | `/hooks/:token` | Receive external event and execute active workflow immediately |

## Data model

- `User`: Google identity and profile.
- `GoogleConnection`: encrypted access/refresh tokens, scopes, expiry.
- `Workflow`: owner, JSON graph, active state, secret webhook token.
- `Execution`: workflow run status, input/output, error and timestamps.
- `ExecutionStep`: per-node status, input/output, error and timestamps.

## Security and production checklist

- Set strong, unique `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`; back up the encryption key securely. Losing it makes stored Google tokens unreadable.
- Use HTTPS and secure cookies; set `APP_URL`, `FRONTEND_URL`, `CORS_ORIGINS`, and OAuth callback to your production domain.
- Keep `.env`, OAuth secrets, database credentials, and webhook URLs private.
- Restrict database/network access; configure automated encrypted backups.
- Add CSRF protection for state-changing cookie-authenticated API routes before exposing the app publicly. OAuth uses a random session-bound state value.
- Add webhook HMAC signatures, per-user quotas, payload size limits, idempotency keys, and abuse monitoring for production.
- Restrict outbound HTTP destinations to prevent SSRF (private IPs, metadata endpoints, and internal hostnames); the starter's HTTPS-only production check is not a complete SSRF defense.
- Move executions to a durable queue/worker (e.g. BullMQ + Redis), add concurrency limits, timeout policies, retry/backoff, dead-letter handling, and transactional outbox semantics before high-volume use.
- Consider Google OAuth verification and scope minimization before onboarding external users.
- This starter logs execution input/output for debugging. Do not send sensitive personal data until you have added data retention controls and redaction.

## Notes / limitations

- The web console currently creates a simple webhook → Google Sheets workflow. Advanced graph editing can be added by wiring the retained `/demo.html` visual editor to the workflow APIs.
- Google Sheets writes are real. Spreadsheet listing and tab discovery use Google Drive/Sheets APIs. The Google account must have access to the target spreadsheet.
- Execution is synchronous in the webhook request. Long-running workflows may time out; the durable worker architecture is the next recommended enhancement.
- Email/WhatsApp integrations, bidirectional sync, polling triggers, OAuth connections for other providers, and a full Make-like node editor are not included yet.
