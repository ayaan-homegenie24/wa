# Meta WhatsApp Cloud API — Full Stack Setup Guide

## Files in this project

```
whatsapp-api/
├── .env                  ← ALL your IDs go here (one file, one place)
├── package.json
├── backend/
│   └── server.js         ← Express API server
└── frontend/
    └── index.html        ← Test dashboard (served by Express)
```

---

## Step 1 — Collect your IDs from Meta

| ID | Where to find it |
|----|-----------------|
| `APP_ID` | developers.facebook.com → Your App → Settings → Basic |
| `APP_SECRET` | developers.facebook.com → Your App → Settings → Basic |
| `WABA_ID` | business.facebook.com → WhatsApp Accounts → click account |
| `PHONE_NUMBER_ID` | developers.facebook.com → Your App → WhatsApp → API Setup (it says "Phone number ID" — not the actual number) |
| `ACCESS_TOKEN` | business.facebook.com → System Users → Add User → Generate Token (permissions: whatsapp_business_messaging + whatsapp_business_management) |
| `WEBHOOK_VERIFY_TOKEN` | **You invent this** — any string, e.g. `my_wh_secret_2024` |

---

## Step 2 — Fill in .env

Open `.env` and replace every `<<<REPLACE_THIS_...>>>` value:

```
APP_ID=123456789012345
APP_SECRET=abcdef1234567890abcdef1234567890
WABA_ID=123456789012345
PHONE_NUMBER_ID=123456789012345
ACCESS_TOKEN=EAAxxxxx....(long token)
WEBHOOK_VERIFY_TOKEN=my_wh_secret_2024
GRAPH_API_VERSION=v19.0
PORT=3000
```

---

## Step 3 — Install and run

```bash
npm install
npm start
```

Open http://localhost:3000 — the dashboard shows green ticks when your IDs are loaded.

---

## Step 4 — Register your webhook

1. Go to: developers.facebook.com → Your App → WhatsApp → Configuration
2. Click **Edit** under Webhooks
3. Enter:
   - **Callback URL**: `https://YOUR_PUBLIC_DOMAIN/webhook`
   - **Verify Token**: the value you set in `WEBHOOK_VERIFY_TOKEN`
4. Click **Verify and Save**
5. Subscribe to: `messages`, `message_deliveries`, `message_reads`

> **Local development**: use [ngrok](https://ngrok.com/) to expose localhost:
> ```bash
> ngrok http 3000
> # Copy the https URL → use as your Callback URL
> ```

---

## API Endpoints reference

| Method | Path | Body |
|--------|------|------|
| GET | `/` | — health check |
| POST | `/send-message` | `{ to, message }` |
| POST | `/send-template` | `{ to, template_name, language }` |
| POST | `/send-media` | `{ to, type, link, caption }` |
| POST | `/mark-read` | `{ message_id }` |
| GET | `/templates` | — lists your WABA templates |
| GET | `/webhook` | — Meta verification (auto) |
| POST | `/webhook` | — incoming messages (auto) |

---

## Common issues

| Problem | Fix |
|---------|-----|
| 401 Unauthorized | ACCESS_TOKEN is wrong or expired — regenerate in Meta Business Manager |
| 403 on webhook | WEBHOOK_VERIFY_TOKEN in .env doesn't match what you typed in Meta dashboard |
| Message not delivered | Recipient must have messaged your number first (24hr window), OR use a template |
| "Phone number not registered" | PHONE_NUMBER_ID is wrong — use the ID, not the actual phone number |
