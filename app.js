// app.js
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// --- ENV
const port = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WABA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- Clients
const oai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Very simple session store (swap to Redis/DB in prod)
const sessions = new Map(); // key: user phone, value: { mode }

// --- Modes & prompts
const MODES = {
  customer: {
    label: 'Customer',
    system: `You are a helpful customer support assistant.
- Ask for name, issue, and any order/account reference.
- Keep answers concise and actionable.`
  },
  zim: {
    label: 'ZIM Student',
    system: `You are ZIM Student assistant.
- Help with exam applications, results, schedules, and fees.
- If asked about personal records, request student ID or NRC.
- Be precise; do not invent policy.`
  },
  awanachi: {
    label: 'Awanachi Subscriber',
    system: `You are Awanachi Magazine subscription assistant.
- Help with plans, payments, delivery, and account access.
- Offer renewal help and summarize latest issue topics if asked.`
  }
};

// --- WhatsApp send helpers
async function sendWhatsApp(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${WABA_TOKEN}` }
  });
}

async function sendMenu(to) {
  await sendWhatsApp(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Hi! Choose an option:" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "opt_customer", title: "1) Customer" } },
          { type: "reply", reply: { id: "opt_zim", title: "2) ZIM Student" } },
          { type: "reply", reply: { id: "opt_awanachi", title: "3) Awanachi Subscriber" } }
        ]
      }
    }
  });
}

async function sendText(to, text) {
  await sendWhatsApp(to, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  });
}

function mapButtonToMode(btnId) {
  if (btnId === 'opt_customer') return 'customer';
  if (btnId === 'opt_zim') return 'zim';
  if (btnId === 'opt_awanachi') return 'awanachi';
  return null;
}

async function chatWithOpenAI(mode, userText) {
  const sys = MODES[mode]?.system || "You are a helpful assistant.";
  const resp = await oai.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: sys },
      { role: "user", content: userText }
    ]
  });
  return resp.output_text || "Sorry, I didn’t catch that.";
}

// --- Webhook verify (GET /) — your original, kept intact
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

// --- Webhook receiver (POST /)
app.post('/', async (req, res) => {
  res.sendStatus(200); // ACK immediately

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    if (!message || !from) return;

    // Simple "menu" command
    const txt = message.text?.body?.trim().toLowerCase();
    if (txt === 'menu') {
      await sendMenu(from);
      return;
    }

    // Button reply
    if (message.type === "interactive" && message.interactive?.type === "button_reply") {
      const id = message.interactive.button_reply.id;
      const mode = mapButtonToMode(id);
      if (mode) {
        sessions.set(from, { mode });
        await sendText(from, `Great — you chose ${MODES[mode].label}. How can I help? (type "menu" to switch)`);
      } else {
        await sendMenu(from);
      }
      return;
    }

    // First contact - allow 1/2/3 shortcuts, otherwise show menu
    let sess = sessions.get(from);
    if (!sess) {
      if (['1','2','3'].includes(txt)) {
        const picked = txt === '1' ? 'customer' : txt === '2' ? 'zim' : 'awanachi';
        sessions.set(from, { mode: picked });
        await sendText(from, `Great — you chose ${MODES[picked].label}. How can I help? (type "menu" to switch)`);
      } else {
        await sendMenu(from);
      }
      return;
    }

    // Route to ChatGPT
    if (message.type === "text" && txt) {
      const reply = await chatWithOpenAI(sess.mode, message.text.body);
      await sendText(from, reply);
      return;
    }

    // Fallback
    await sendText(from, `Sorry, I can only handle text and buttons for now. Type "menu" to see options.`);
  } catch (e) {
    console.error("Handler error:", e?.response?.data || e.message);
  }
});

app.listen(port, () => console.log(`\nListening on port ${port}\n`));
