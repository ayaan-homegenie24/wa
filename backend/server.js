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

const {
  PHONE_NUMBER_ID,
  ACCESS_TOKEN,
  WEBHOOK_VERIFY_TOKEN,
  GRAPH_API_VERSION = "v19.0",
  WABA_ID,
  PORT = 3000,
} = process.env;

const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ── IN-MEMORY STORE ──────────────────────────────────────────────────────────
const conversations = {};

function getOrCreate(phone, name) {
  if (!conversations[phone]) {
    conversations[phone] = {
      name: name || phone,
      phone,
      messages: [],
      unread: 0,
      agent: "",
      label: "",
      status: "open",
    };
  }
  return conversations[phone];
}

// ── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => res.write(payload));
}

app.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  sseClients.add(res);
  const hb = setInterval(() => res.write(": heartbeat\n\n"), 20000);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    phone_number_id: PHONE_NUMBER_ID ? "✅ set" : "❌ MISSING",
    access_token:    ACCESS_TOKEN    ? "✅ set" : "❌ MISSING",
    webhook_token:   WEBHOOK_VERIFY_TOKEN ? "✅ set" : "❌ MISSING",
  });
});

// ── LIST CONVERSATIONS ────────────────────────────────────────────────────────
app.get("/api/conversations", (req, res) => {
  const list = Object.values(conversations).map((c) => ({
    phone:   c.phone,
    name:    c.name,
    lastMsg: c.messages[c.messages.length - 1]?.text || "",
    lastT:   c.messages[c.messages.length - 1]?.t    || "",
    unread:  c.unread,
    agent:   c.agent,
    label:   c.label,
    status:  c.status,
  }));
  res.json(list);
});

// ── GET ONE CONVERSATION ──────────────────────────────────────────────────────
app.get("/api/conversations/:phone", (req, res) => {
  const c = conversations[req.params.phone];
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c);
});

// ── MARK READ — only called when agent opens a chat ──────────────────────────
app.post("/api/conversations/:phone/read", async (req, res) => {
  const c = conversations[req.params.phone];
  if (!c) return res.status(404).json({ error: "Not found" });

  // Mark all unread incoming messages as read on Meta
  const unreadMsgs = c.messages.filter(m => m.dir === "in" && !m.read && m.id);
  for (const msg of unreadMsgs) {
    try {
      await axios.post(
        `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", status: "read", message_id: msg.id },
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );
      msg.read = true;
    } catch (e) {}
  }
  c.unread = 0;
  res.json({ ok: true });
});

// ── PATCH CONVO ───────────────────────────────────────────────────────────────
app.patch("/api/conversations/:phone", (req, res) => {
  const c = getOrCreate(req.params.phone);
  const { agent, label, status } = req.body;
  if (agent  !== undefined) c.agent  = agent;
  if (label  !== undefined) c.label  = label;
  if (status !== undefined) c.status = status;
  broadcast("conversation_updated", { phone: c.phone, agent: c.agent, label: c.label, status: c.status });
  res.json({ ok: true });
});

// ── SEND TEXT ─────────────────────────────────────────────────────────────────
app.post("/api/send-message", async (req, res) => {
  const { to, message, clientMsgId } = req.body;
  if (!to || !message) return res.status(400).json({ error: "to and message are required" });

  try {
    const r = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: message } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    const waId = r.data.messages?.[0]?.id;
    const c = getOrCreate(to);
    const msg = {
      dir: "out", type: "text", text: message,
      t: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      id: waId, clientMsgId, status: "sent"
    };
    c.messages.push(msg);
    // Broadcast with clientMsgId so frontend can deduplicate
    broadcast("new_message", { phone: to, message: msg, meta: { name: c.name, unread: 0 }, isEcho: true });
    res.json({ success: true, data: r.data, msgId: waId });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── SEND TEMPLATE ─────────────────────────────────────────────────────────────
app.post("/api/send-template", async (req, res) => {
  const { to, template_name, language = "en_US", components = [] } = req.body;
  try {
    const r = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "template", template: { name: template_name, language: { code: language }, components } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    res.json({ success: true, data: r.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── SEND MEDIA ────────────────────────────────────────────────────────────────
app.post("/api/send-media", async (req, res) => {
  const { to, type, link, caption } = req.body;
  const mediaObject = { link };
  if (caption) mediaObject.caption = caption;
  try {
    const r = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type, [type]: mediaObject },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    res.json({ success: true, data: r.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── LIST TEMPLATES ────────────────────────────────────────────────────────────
app.get("/api/templates", async (req, res) => {
  try {
    const r = await axios.get(`${BASE_URL}/${WABA_ID}/message_templates`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    res.json({ success: true, data: r.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── CREATE TEMPLATE ───────────────────────────────────────────────────────────
app.post("/api/templates", async (req, res) => {
  const { name, category, language, body, header, footer, buttons } = req.body;
  const components = [];
  if (header) components.push({ type: "HEADER", format: "TEXT", text: header });
  components.push({ type: "BODY", text: body });
  if (footer) components.push({ type: "FOOTER", text: footer });
  if (buttons && buttons.length) {
    components.push({
      type: "BUTTONS",
      buttons: buttons.map(b => ({ type: b.type || "QUICK_REPLY", text: b.text }))
    });
  }
  try {
    const r = await axios.post(
      `${BASE_URL}/${WABA_ID}/message_templates`,
      { name, category, language, components },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    res.json({ success: true, data: r.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── WEBHOOK VERIFY ────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) { console.log("✅ Webhook verified"); return res.status(200).send(challenge); }
  console.error("❌ Token mismatch"); res.sendStatus(403);
});

// ── WEBHOOK RECEIVE ───────────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  res.sendStatus(200); // ack Meta immediately
  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  body.entry?.forEach((entry) => {
    entry.changes?.forEach((change) => {
      const value = change.value;
      const contacts_map = {};
      (value.contacts || []).forEach((c) => { contacts_map[c.wa_id] = c.profile?.name || c.wa_id; });

      // Incoming messages
      (value.messages || []).forEach((msg) => {
        const phone = msg.from;
        const name  = contacts_map[phone] || phone;
        const c     = getOrCreate(phone, name);
        if (!c.name || c.name === phone) c.name = name;

        let text = "";
        if (msg.type === "text")          text = msg.text?.body || "";
        else if (msg.type === "image")    text = `[Image] ${msg.image?.caption || ""}`.trim();
        else if (msg.type === "document") text = `[Document] ${msg.document?.filename || ""}`.trim();
        else if (msg.type === "audio")    text = "[Audio message]";
        else if (msg.type === "video")    text = "[Video]";
        else if (msg.type === "sticker")  text = "[Sticker]";
        else if (msg.type === "location") text = `[Location] lat:${msg.location?.latitude} lng:${msg.location?.longitude}`;
        else text = `[${msg.type}]`;

        const msgObj = {
          dir: "in", type: msg.type, text,
          t: new Date(parseInt(msg.timestamp) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          id: msg.id, read: false,
        };
        c.messages.push(msgObj);
        c.unread++;
        console.log(`📩 [${name}] ${text}`);

        // DO NOT mark as read here — only when agent opens the chat
        broadcast("new_message", { phone, message: msgObj, meta: { name: c.name, unread: c.unread, status: c.status } });
      });

      // Status updates — sent/delivered/read
      (value.statuses || []).forEach((s) => {
        console.log(`📋 ${s.status} for ${s.id}`);
        // Find the message and update its status
        Object.values(conversations).forEach(c => {
          const msg = c.messages.find(m => m.id === s.id);
          if (msg) { msg.status = s.status; broadcast("status_update", { id: s.id, status: s.status, phone: s.recipient_id }); }
        });
      });
    });
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  Server on http://localhost:${PORT}`);
  console.log(`    Webhook: http://YOUR_DOMAIN/webhook\n`);
});
