require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));

const { PHONE_NUMBER_ID, ACCESS_TOKEN, WEBHOOK_VERIFY_TOKEN, GRAPH_API_VERSION = "v19.0", WABA_ID, PORT = 3000 } = process.env;
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ── STORE ────────────────────────────────────────────────────────────────────
const conversations = {};
function getOrCreate(phone, name) {
  if (!conversations[phone]) conversations[phone] = { name: name||phone, phone, messages:[], unread:0, agent:"", label:"", status:"open" };
  return conversations[phone];
}

// ── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const p = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(r => r.write(p));
}
app.get("/events", (req, res) => {
  res.set({ "Content-Type":"text/event-stream", "Cache-Control":"no-cache", Connection:"keep-alive" });
  res.flushHeaders(); sseClients.add(res);
  const hb = setInterval(() => res.write(": hb\n\n"), 20000);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({
  phone_number_id: PHONE_NUMBER_ID ? "✅ set":"❌ MISSING",
  access_token:    ACCESS_TOKEN    ? "✅ set":"❌ MISSING",
  webhook_token:   WEBHOOK_VERIFY_TOKEN ? "✅ set":"❌ MISSING",
}));

// ── CONVERSATIONS ─────────────────────────────────────────────────────────────
app.get("/api/conversations", (req, res) => {
  res.json(Object.values(conversations).map(c => ({
    phone:c.phone, name:c.name,
    lastMsg:c.messages[c.messages.length-1]?.text||"",
    lastT:  c.messages[c.messages.length-1]?.t||"",
    unread:c.unread, agent:c.agent, label:c.label, status:c.status,
  })));
});

app.get("/api/conversations/:phone", (req, res) => {
  const c = conversations[req.params.phone];
  if (!c) return res.status(404).json({ error:"Not found" });
  res.json(c);
});

// ── MARK READ — only when agent opens chat ────────────────────────────────────
app.post("/api/conversations/:phone/read", async (req, res) => {
  const c = conversations[req.params.phone];
  if (!c) return res.status(404).json({ error:"Not found" });
  const unread = c.messages.filter(m => m.dir==="in" && !m.read && m.id);
  for (const msg of unread) {
    try {
      await axios.post(`${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
        { messaging_product:"whatsapp", status:"read", message_id:msg.id },
        { headers:{ Authorization:`Bearer ${ACCESS_TOKEN}`, "Content-Type":"application/json" } });
      msg.read = true;
    } catch(e) {}
  }
  c.unread = 0;
  res.json({ ok:true });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────
app.patch("/api/conversations/:phone", (req, res) => {
  const c = getOrCreate(req.params.phone);
  const { agent, label, status } = req.body;
  if (agent  !== undefined) c.agent  = agent;
  if (label  !== undefined) c.label  = label;
  if (status !== undefined) c.status = status;
  broadcast("conversation_updated", { phone:c.phone, agent:c.agent, label:c.label, status:c.status });
  res.json({ ok:true });
});

// ── SEND TEXT ─────────────────────────────────────────────────────────────────
app.post("/api/send-message", async (req, res) => {
  const { to, message, clientMsgId } = req.body;
  if (!to||!message) return res.status(400).json({ error:"to and message required" });
  try {
    const r = await axios.post(`${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product:"whatsapp", recipient_type:"individual", to, type:"text", text:{ preview_url:false, body:message } },
      { headers:{ Authorization:`Bearer ${ACCESS_TOKEN}`, "Content-Type":"application/json" } });
    const waId = r.data.messages?.[0]?.id;
    const c = getOrCreate(to);
    const msg = { dir:"out", type:"text", text:message, t:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}), id:waId, clientMsgId, status:"sent" };
    c.messages.push(msg);
    broadcast("new_message", { phone:to, message:msg, meta:{ name:c.name, unread:0 }, isEcho:true });
    res.json({ success:true, data:r.data, msgId:waId });
  } catch(err) { res.status(500).json({ error:err.response?.data||err.message }); }
});

// ── SEND TEMPLATE ─────────────────────────────────────────────────────────────
app.post("/api/send-template", async (req, res) => {
  const { to, template_name, language="en_US", components=[] } = req.body;
  try {
    const r = await axios.post(`${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product:"whatsapp", to, type:"template", template:{ name:template_name, language:{ code:language }, components } },
      { headers:{ Authorization:`Bearer ${ACCESS_TOKEN}`, "Content-Type":"application/json" } });
    res.json({ success:true, data:r.data });
  } catch(err) { res.status(500).json({ error:err.response?.data||err.message }); }
});

// ── SEND MEDIA ────────────────────────────────────────────────────────────────
app.post("/api/send-media", async (req, res) => {
  const { to, type, link, caption } = req.body;
  try {
    const r = await axios.post(`${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product:"whatsapp", to, type, [type]:{ link, ...(caption?{caption}:{}) } },
      { headers:{ Authorization:`Bearer ${ACCESS_TOKEN}`, "Content-Type":"application/json" } });
    res.json({ success:true, data:r.data });
  } catch(err) { res.status(500).json({ error:err.response?.data||err.message }); }
});

// ── GET MEDIA URL from Meta (to display in chat) ──────────────────────────────
app.get("/api/media/:mediaId", async (req, res) => {
  try {
    // Step 1: get the download URL
    const info = await axios.get(`${BASE_URL}/${req.params.mediaId}`,
      { headers:{ Authorization:`Bearer ${ACCESS_TOKEN}` } });
    const url = info.data.url;
    // Step 2: stream the file back through our server (Meta requires auth header)
    const file = await axios.get(url, { headers:{ Authorization:`Bearer ${ACCESS_TOKEN}` }, responseType:"stream" });
    res.set("Content-Type", file.headers["content-type"]);
    file.data.pipe(res);
  } catch(err) { res.status(500).json({ error:err.response?.data||err.message }); }
});

// ── LIST TEMPLATES ────────────────────────────────────────────────────────────
app.get("/api/templates", async (req, res) => {
  try {
    const r = await axios.get(`${BASE_URL}/${WABA_ID}/message_templates`,
      { headers:{ Authorization:`Bearer ${ACCESS_TOKEN}` } });
    res.json({ success:true, data:r.data });
  } catch(err) { res.status(500).json({ error:err.response?.data||err.message }); }
});

// ── CREATE TEMPLATE ───────────────────────────────────────────────────────────
app.post("/api/templates", async (req, res) => {
  const { name, category, language, body, header, headerType, headerMediaUrl, footer, buttons } = req.body;
  const components = [];
  if (header) {
    if (headerType === "TEXT") {
      components.push({ type:"HEADER", format:"TEXT", text:header });
    } else if (["IMAGE","VIDEO","DOCUMENT"].includes(headerType)) {
      components.push({ type:"HEADER", format:headerType,
        example:{ header_handle:[headerMediaUrl||"https://example.com/sample.jpg"] } });
    }
  }
  components.push({ type:"BODY", text:body });
  if (footer) components.push({ type:"FOOTER", text:footer });
  if (buttons?.length) components.push({ type:"BUTTONS", buttons:buttons.map(b=>({ type:b.type||"QUICK_REPLY", text:b.text })) });
  try {
    const r = await axios.post(`${BASE_URL}/${WABA_ID}/message_templates`,
      { name, category, language, components },
      { headers:{ Authorization:`Bearer ${ACCESS_TOKEN}`, "Content-Type":"application/json" } });
    res.json({ success:true, data:r.data });
  } catch(err) { res.status(500).json({ error:err.response?.data||err.message }); }
});

// ── WEBHOOK VERIFY ────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const { "hub.mode":mode, "hub.verify_token":token, "hub.challenge":challenge } = req.query;
  if (mode==="subscribe" && token===WEBHOOK_VERIFY_TOKEN) { console.log("✅ Webhook verified"); return res.status(200).send(challenge); }
  console.error("❌ Token mismatch"); res.sendStatus(403);
});

// ── WEBHOOK RECEIVE ───────────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  body.entry?.forEach(entry => entry.changes?.forEach(change => {
    const value = change.value;
    const cmap  = {};
    (value.contacts||[]).forEach(c => cmap[c.wa_id] = c.profile?.name||c.wa_id);

    (value.messages||[]).forEach(msg => {
      const phone = msg.from;
      const name  = cmap[phone]||phone;
      const c     = getOrCreate(phone, name);
      if (!c.name||c.name===phone) c.name = name;

      // Build message object based on type
      let text = "", mediaId = null, mediaType = null, fileName = null, mimeType = null;

      if (msg.type==="text") {
        text = msg.text?.body||"";
      } else if (msg.type==="image") {
        mediaId = msg.image?.id; mimeType = msg.image?.mime_type;
        mediaType = "image"; text = msg.image?.caption||"";
      } else if (msg.type==="video") {
        mediaId = msg.video?.id; mimeType = msg.video?.mime_type;
        mediaType = "video"; text = msg.video?.caption||"";
      } else if (msg.type==="audio") {
        mediaId = msg.audio?.id; mimeType = msg.audio?.mime_type;
        mediaType = "audio"; text = "";
      } else if (msg.type==="document") {
        mediaId = msg.document?.id; mimeType = msg.document?.mime_type;
        fileName = msg.document?.filename; mediaType = "document"; text = msg.document?.caption||fileName||"Document";
      } else if (msg.type==="sticker") {
        mediaId = msg.sticker?.id; mediaType = "sticker"; text = "[Sticker]";
      } else if (msg.type==="location") {
        text = `📍 Location: ${msg.location?.latitude}, ${msg.location?.longitude}`;
      } else {
        text = `[${msg.type}]`;
      }

      const msgObj = {
        dir:"in", type:msg.type, text,
        mediaId, mediaType, fileName, mimeType,
        t: new Date(parseInt(msg.timestamp)*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),
        id:msg.id, read:false,
      };
      c.messages.push(msgObj);
      c.unread++;
      console.log(`📩 [${name}] type:${msg.type} ${text}`);

      // DO NOT mark read here — only when agent opens the chat
      broadcast("new_message", { phone, message:msgObj, meta:{ name:c.name, unread:c.unread, status:c.status } });
    });

    (value.statuses||[]).forEach(s => {
      Object.values(conversations).forEach(c => {
        const m = c.messages.find(m => m.id===s.id);
        if (m) { m.status=s.status; broadcast("status_update", { id:s.id, status:s.status, phone:s.recipient_id }); }
      });
    });
  }));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
