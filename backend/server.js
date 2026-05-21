/**
 * META WHATSAPP CLOUD API — BACKEND SERVER
 * =========================================
 * Node.js + Express
 * Replace IDs in .env before running.
 *
 * Start: npm install && node server.js
 */

require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ----------------------------------------------------------
// CONFIG — loaded from .env (no hardcoded credentials here)
// ----------------------------------------------------------
const {
  PHONE_NUMBER_ID,      // <<<  from .env
  ACCESS_TOKEN,         // <<<  from .env
  WEBHOOK_VERIFY_TOKEN, // <<<  from .env
  GRAPH_API_VERSION,    // <<<  from .env
  WABA_ID,              // <<<  from .env
  PORT,
} = process.env;

const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ----------------------------------------------------------
// HEALTH CHECK
// ----------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    phone_number_id: PHONE_NUMBER_ID ? "✅ set" : "❌ MISSING",
    access_token: ACCESS_TOKEN ? "✅ set" : "❌ MISSING",
    webhook_token: WEBHOOK_VERIFY_TOKEN ? "✅ set" : "❌ MISSING",
  });
});

// ----------------------------------------------------------
// SEND A TEXT MESSAGE
//
// POST /send-message
// Body: { to: "91XXXXXXXXXX", message: "Hello!" }
// ----------------------------------------------------------
app.post("/send-message", async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: "to and message are required" });
  }

  try {
    const response = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`, // PHONE_NUMBER_ID from .env
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`, // ACCESS_TOKEN from .env
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ----------------------------------------------------------
// SEND A TEMPLATE MESSAGE
//
// POST /send-template
// Body: { to: "91XXXXXXXXXX", template_name: "hello_world", language: "en_US" }
//
// Create templates in:
// Meta Business Manager → WhatsApp → Message Templates
// ----------------------------------------------------------
app.post("/send-template", async (req, res) => {
  const { to, template_name, language = "en_US", components = [] } = req.body;

  try {
    const response = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template_name,
          language: { code: language },
          components,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ----------------------------------------------------------
// SEND MEDIA (image, document, audio, video)
//
// POST /send-media
// Body: { to, type: "image", link: "https://...", caption: "..." }
// ----------------------------------------------------------
app.post("/send-media", async (req, res) => {
  const { to, type, link, caption } = req.body;

  const mediaObject = { link };
  if (caption) mediaObject.caption = caption;

  try {
    const response = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type,
        [type]: mediaObject,
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ----------------------------------------------------------
// MARK MESSAGE AS READ
//
// POST /mark-read
// Body: { message_id: "wamid.XXX" }
// ----------------------------------------------------------
app.post("/mark-read", async (req, res) => {
  const { message_id } = req.body;

  try {
    const response = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id,
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ----------------------------------------------------------
// GET TEMPLATES (list all message templates for your WABA)
// GET /templates
// ----------------------------------------------------------
app.get("/templates", async (req, res) => {
  try {
    const response = await axios.get(
      `${BASE_URL}/${WABA_ID}/message_templates`, // WABA_ID from .env
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ----------------------------------------------------------
// WEBHOOK — VERIFICATION (GET)
// Meta calls this once when you register your webhook URL
// ----------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  console.error("❌ Webhook verification failed — token mismatch");
  res.sendStatus(403);
});

// ----------------------------------------------------------
// WEBHOOK — RECEIVE MESSAGES (POST)
// Meta sends incoming messages here
// ----------------------------------------------------------
app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object !== "whatsapp_business_account") return res.sendStatus(404);

  body.entry?.forEach((entry) => {
    entry.changes?.forEach((change) => {
      const value = change.value;

      // Incoming messages
      value.messages?.forEach((msg) => {
        console.log("📩 Incoming message:", JSON.stringify(msg, null, 2));

        // TODO: Add your bot logic / DB save / auto-reply here
        // Example: if (msg.type === "text") autoReply(msg.from, msg.text.body)
      });

      // Status updates (sent, delivered, read, failed)
      value.statuses?.forEach((status) => {
        console.log("📋 Status update:", status.status, "for", status.id);
      });
    });
  });

  res.sendStatus(200);
});

// ----------------------------------------------------------
// START SERVER
// ----------------------------------------------------------
app.listen(PORT || 3000, () => {
  console.log(`\n🚀 WhatsApp API server running on port ${PORT || 3000}`);
  console.log(`   Webhook URL: http://YOUR_DOMAIN/webhook`);
  console.log(`   Health:      http://localhost:${PORT || 3000}/\n`);
});
