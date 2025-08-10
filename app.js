// app.js
// WhatsApp bot with 3-option menu (no ChatGPT) + simple guided flows

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ======= ENV VARS =======
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;                   // same as in Meta webhook form
const WABA_TOKEN = process.env.WHATSAPP_TOKEN;                   // System User access token
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;    // WhatsApp > API Setup

function assertEnv(name, val) {
  if (!val) console.warn(`[WARN] Missing env var ${name}`);
}
assertEnv('VERIFY_TOKEN', VERIFY_TOKEN);
assertEnv('WHATSAPP_TOKEN', WABA_TOKEN);
assertEnv('WHATSAPP_PHONE_NUMBER_ID', PHONE_NUMBER_ID);

// ======= IN-MEMORY SESSIONS =======
/*
  sessions.set(from, {
    mode: 'customer'|'zim'|'awanachi',
    step: string|null,
    data: { ...collected fields... }
  })
*/
const sessions = new Map();

// ======= HELPERS: WhatsApp senders =======
async function sendWhatsApp(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    // console.log('[WA SEND] ->', JSON.stringify(payload)); // uncomment to debug outgoing payload
    await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${WABA_TOKEN}` },
      timeout: 15000,
    });
  } catch (e) {
    console.error('Handler error:', e?.response?.data || e.message);
  }
}

async function sendText(to, text) {
  return sendWhatsApp(to, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

function safeTitle(s) {
  if (!s) return 'Option';
  const trimmed = String(s).trim();
  // WhatsApp constraint: 1..20 characters, avoid newlines
  return trimmed.replace(/\s+/g, ' ').slice(0, 20);
}

async function sendMenu(to) {
  const b1 = safeTitle('Customer');
  const b2 = safeTitle('ZIM Student');
  const b3 = safeTitle('Awanachi');
  return sendWhatsApp(to, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Hi! Choose an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'opt_customer',  title: b1 } },
          { type: 'reply', reply: { id: 'opt_zim',       title: b2 } },
          { type: 'reply', reply: { id: 'opt_awanachi',  title: b3 } },
        ],
      },
    },
  });
}

async function sendYesNo(to, idYes, idNo, promptText) {
  return sendWhatsApp(to, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: promptText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: idYes, title: safeTitle('Yes') } },
          { type: 'reply', reply: { id: idNo,  title: safeTitle('No') } },
        ],
      },
    },
  });
}

// ======= FLOW HELPERS =======
function setSession(from, updates) {
  const current = sessions.get(from) || {};
  const next = { ...current, ...updates };
  sessions.set(from, next);
  return next;
}

function clearSession(from) {
  sessions.delete(from);
}

function parseYesNo(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (['yes', 'y', 'yeah', 'yep', '1'].includes(t)) return true;
  if (['no', 'n', 'nope', '0', '2'].includes(t)) return false;
  return null;
}

// ======= FLOWS =======
// Customer: immediate reply
async function startCustomerFlow(from) {
  setSession(from, { mode: 'customer', step: null, data: {} });
  return sendText(from, 'Thank you for considering our services. How can we serve you today?');
}

// ZIM Student: first name → last name → email → last sitting yes/no → final message
async function startZimFlow(from) {
  setSession(from, { mode: 'zim', step: 'zim_first_name', data: {} });
  return sendText(from, 'What is your first name?');
}

async function handleZimStep(from, messageText) {
  const sess = sessions.get(from);
  if (!sess) return startZimFlow(from);

  switch (sess.step) {
    case 'zim_first_name': {
      const first = (messageText || '').trim();
      if (!first) return sendText(from, 'Please provide your first name:');
      setSession(from, { step: 'zim_last_name', data: { ...sess.data, first_name: first } });
      return sendText(from, 'What is your last name?');
    }
    case 'zim_last_name': {
      const last = (messageText || '').trim();
      if (!last) return sendText(from, 'Please provide your last name:');
      setSession(from, { step: 'zim_email', data: { ...sess.data, last_name: last } });
      return sendText(from, 'What is your email address?');
    }
    case 'zim_email': {
      const email = (messageText || '').trim();
      // very light validation
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!ok) return sendText(from, 'Please provide a valid email address:');
      setSession(from, { step: 'zim_last_sitting', data: { ...sess.data, email } });
      return sendYesNo(from, 'zim_exam_yes', 'zim_exam_no', 'Did you write exams in the last sitting? Yes/No');
    }
    case 'zim_last_sitting': {
      // If user typed text instead of pressing buttons
      const yn = parseYesNo(messageText);
      if (yn === true) {
        await sendText(from, 'Your issue has been escalated. Please give us some time.');
        clearSession(from);
        return sendText(from, 'Type "menu" to start over or choose another option any time.');
      }
      if (yn === false) {
        await sendText(from, 'We are prioritising the students that wrote exams in the last sitting; however, please give us some time and you will receive an email with a link to activate your account when it is created.');
        clearSession(from);
        return sendText(from, 'Type "menu" to start over or choose another option any time.');
      }
      // If neither, re-show Yes/No buttons
      return sendYesNo(from, 'zim_exam_yes', 'zim_exam_no', 'Did you write exams in the last sitting? Yes/No');
    }
    default:
      // reset if unknown step
      return startZimFlow(from);
  }
}

// Awanachi: active subscription yes/no → if yes ask email, if no ask how to help
async function startAwanachiFlow(from) {
  setSession(from, { mode: 'awanachi', step: 'awanachi_active', data: {} });
  return sendYesNo(from, 'awanachi_active_yes', 'awanachi_active_no', 'Do you have an active subscription? Yes/No');
}

async function handleAwanachiStep(from, messageText) {
  const sess = sessions.get(from);
  if (!sess) return startAwanachiFlow(from);

  switch (sess.step) {
    case 'awanachi_active': {
      const yn = parseYesNo(messageText);
      if (yn === true) {
        setSession(from, { step: 'awanachi_email' });
        return sendText(from, 'Great. What is your email address?');
      }
      if (yn === false) {
        setSession(from, { step: 'awanachi_help' });
        return sendText(from, 'How can we help you?');
      }
      // re-ask with buttons
      return sendYesNo(from, 'awanachi_active_yes', 'awanachi_active_no', 'Do you have an active subscription? Yes/No');
    }
    case 'awanachi_email': {
      const email = (messageText || '').trim();
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!ok) return sendText(from, 'Please provide a valid email address:');
      // Here you could look up the subscription by email or create a ticket
      clearSession(from);
      await sendText(from, 'Thanks! We will review your subscription details and follow up shortly.');
      return sendText(from, 'Type "menu" to start over or choose another option any time.');
    }
    case 'awanachi_help': {
      const helpText = (messageText || '').trim();
      if (!helpText) return sendText(from, 'Please tell us how we can help you:');
      clearSession(from);
      await sendText(from, 'Thank you for the details. We will get back to you shortly.');
      return sendText(from, 'Type "menu" to start over or choose another option any time.');
    }
    default:
      return startAwanachiFlow(from);
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
  // ACK quickly
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const from = message?.from;

    if (!message || !from) return;

    // Shortcuts
    const txt = message.text?.body?.trim();
    const txtLower = txt?.toLowerCase();

    // "menu" always shows the menu & resets pending step
    if (txtLower === 'menu') {
      sessions.delete(from);
      await sendMenu(from);
      return;
    }

    // Handle button replies first
    if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
      const btn = message.interactive.button_reply;
      const id = btn?.id;

      // Main menu buttons
      if (id === 'opt_customer') {
        await startCustomerFlow(from);
        return;
      }
      if (id === 'opt_zim') {
        await startZimFlow(from);
        return;
      }
      if (id === 'opt_awanachi') {
        await startAwanachiFlow(from);
        return;
      }

      // ZIM Yes/No
      if (id === 'zim_exam_yes') {
        await sendText(from, 'Your issue has been escalated. Please give us some time.');
        clearSession(from);
        await sendText(from, 'Type "menu" to start over or choose another option any time.');
        return;
      }
      if (id === 'zim_exam_no') {
        await sendText(from, 'We are prioritising the students that wrote exams in the last sitting; however, please give us some time and you will receive an email with a link to activate your account when it is created.');
        clearSession(from);
        await sendText(from, 'Type "menu" to start over or choose another option any time.');
        return;
      }

      // Awanachi Yes/No
      if (id === 'awanachi_active_yes') {
        setSession(from, { mode: 'awanachi', step: 'awanachi_email', data: {} });
        await sendText(from, 'Great. What is your email address?');
        return;
      }
      if (id === 'awanachi_active_no') {
        setSession(from, { mode: 'awanachi', step: 'awanachi_help', data: {} });
        await sendText(from, 'How can we help you?');
        return;
      }
    }

    // First contact (no session): support numeric shortcuts 1/2/3
    let sess = sessions.get(from);
    if (!sess) {
      if (txtLower === '1') return startCustomerFlow(from);
      if (txtLower === '2') return startZimFlow(from);
      if (txtLower === '3') return startAwanachiFlow(from);
      // otherwise show menu
      await sendMenu(from);
      return;
    }

    // If we have an active mode, route text to that flow
    if (sess.mode === 'customer') {
      // For Customer, just echo the initial message & keep session or end; we’ll just keep it simple
      await sendText(from, 'Thank you for considering our services. How can we serve you today?');
      return;
    }

    if (sess.mode === 'zim') {
      await handleZimStep(from, txt);
      return;
    }

    if (sess.mode === 'awanachi') {
      await handleAwanachiStep(from, txt);
      return;
    }

    // Fallback
    await sendMenu(from);
  } catch (e) {
    console.error('Handler error:', e?.response?.data || e.message);
  }
});

// ======= START SERVER =======
app.listen(PORT, () => {
  console.log(`\nListening on port ${PORT}\n`);
});
