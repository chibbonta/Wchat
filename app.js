// app.js
// Minimal WhatsApp + ChatGPT bot with a 3-option menu

const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// ======= ENV VARS =======
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;                   // same as in Meta webhook form
const WABA_TOKEN = process.env.WHATSAPP_TOKEN;                   // System User access token
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;    // WhatsApp > API Setup
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;               // OpenAI API key

// ======= BASIC VALIDATION =======
function assertEnv(name, val) {
  if (!val) console.warn(`[WARN] Missing env var ${name}`);
}
assertEnv('VERIFY_TOKEN', VERIFY_TOKEN);
assertEnv('WHATSAPP_TOKEN', WABA_TOKEN);
assertEnv('WHATSAPP_PHONE_NUMBER_ID', PHONE_NUMBER_ID);
assertEnv('OPENAI_API_KEY', OPENAI_API_KEY);

// ======= OPENAI CLIENT =======
const oai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ======= SIMPLE IN-MEMORY SESSIONS (swap to Redis/DB in prod) =======
const sessions = new Map(); // key: from (phone), value: { mode: 'customer'|'zim'|'awanachi' }

// ======= MODES & PROMPTS =======
const MODES = {
  customer: {
    label: 'Customer',
    system: `You are a helpful customer support assistant.
- Ask for name, issue, and any relevant order/account reference.
- Keep answers concise and actionable.
- If escalation is needed, collect contact info and summarize the issue clearly.`,
  },
  zim: {
    label: 'ZIM Student',
    system: `You are ZIM Student assistant.
- Help with exam applications, results, schedules, and fees.
- If asked about personal records, request student ID or NRC first.
- Be precise and avoid inventing institutional policies.`,
  },
  awanachi: {
    label: 'Awanachi',
    system: `You are Awanachi Magazine subscription assistant.
- Help with subscription plans, payments, delivery, and account access.
- Offer renewal assistance and summarize the latest issue when asked.`,
  },
};

// ======= WHATSAPP HELPERS =======
async function sendWhatsApp(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${WABA_TOKEN}` },
      timeout: 15000,
    });
  } catch (e) {
    console.error("Handler error:", e?.response?.data || e.message);
  }
}

async function sendText(to, text) {
  return sendWhatsApp(to, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}

async function sendMenu(to) {
  // Button titles MUST be <= 20 chars (WhatsApp constraint)
  return sendWhatsApp(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Hi! Choose an option:" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "opt_customer",  title: "Customer" } },
          { type: "reply", reply: { id: "opt_zim",       title: "ZIM Student" } },
          { type: "reply", reply: { id: "opt_awanachi",  title: "Awanachi" } },
        ],
      },
    },
  });
}

function mapButtonToMode(id) {
  if (id === 'opt_customer') return 'customer';
  if (id === 'opt_zim') return 'zim';
  if (id === 'opt_awanachi') return 'awanachi';
  return null;
}

async function chatWithOpenAI(mode, userText) {
  try {
    const sys = MODES[mode]?.system || "You are a helpful assistant.";
    const resp = await oai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: sys },
        { role: "user", content: userText },
      ],
    });
    return resp.output_text || "Sorry, I didn’t catch that.";
  } catch (e) {
    console.error("OpenAI error:", e?.response?.data || e.message);
    return "I’m having trouble responding right now. Please try again.";
  }
}

// ======= WEBHOOK VERIFY (GET /) =======
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ======= WEBHOOK RECEIVER (POST /) =======
app.post('/', async (req, res) => {
  // ACK immediately (WhatsApp expects a quick 200)
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const from = message?.from; // E.164 phone

    if (!message || !from) return;

    // Optional: simple request logging
    // console.log("Incoming:", JSON.stringify(req.body, null, 2));

    // Text content (if any)
    const txt = message.text?.body?.trim();
    const txtLower = txt?.toLowerCase();

    // "menu" command always shows the menu
    if (txtLower === 'menu') {
      await sendMenu(from);
      return;
    }

    // Handle interactive button reply
    if (message.type === "interactive" && message.interactive?.type === "button_reply") {
      const buttonId = message.interactive.button_reply?.id;
      const mode = mapButtonToMode(buttonId);
      if (mode) {
        sessions.set(from, { mode });
        await sendText(from, `Great — you chose ${MODES[mode].label}. How can I help? (type "menu" to switch)`);
      } else {
        await sendMenu(from);
      }
      return;
    }

    // First contact (no session yet): allow numeric shortcuts 1/2/3, else show menu
    let sess = sessions.get(from);
    if (!sess) {
      if (txtLower === '1' || txtLower === '2' || txtLower === '3') {
        const picked = txtLower === '1' ? 'customer' : txtLower === '2' ? 'zim' : 'awanachi';
        sessions.set(from, { mode: picked });
        await sendText(from, `Great — you chose ${MODES[picked].label}. How can I help? (type "menu" to switch)`);
      } else {
        await sendMenu(from);
      }
      return;
    }

    // If we have a session mode, route text to OpenAI
    if (message.type === "text" && txt) {
      const reply = await chatWithOpenAI(sess.mode, txt);
      await sendText(from, reply);
      return;
    }

    // Fallback for non-text, non-button
    await sendText(from, `Sorry, I can only handle text and buttons for now. Type "menu" to see options.`);
  } catch (e) {
    console.error("Handler error:", e?.response?.data || e.message);
  }
});

// ======= START SERVER =======
app.listen(PORT, () => {
  console.log(`\nListening on port ${PORT}\n`);
});
