/**
 * GeneThrive — Sinch MessageMedia SMS helper
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function shared helper: netlify/functions/sinch-sms.js
 *
 * Usage:
 *   const { sendSms } = require('./sinch-sms');
 *   await sendSms('+61412345678', 'Your vitamins have been dispatched.');
 *
 * ENVIRONMENT VARIABLES (Netlify dashboard → Site → Environment variables):
 *   SINCH_API_KEY      Sinch MessageMedia API key (from Sinch portal)
 *   SINCH_API_SECRET   Sinch MessageMedia API secret
 *   SINCH_SENDER_ID    Approved sender ID or number (e.g. GeneThrive or +61...)
 *
 * Sinch MessageMedia docs: https://messagemedia.github.io/messagemedia-rest-api/
 *
 * Notes:
 *   - Phone numbers must be in E.164 format: +61412345678 (no spaces/dashes)
 *   - sendSms() throws on API error so the caller can decide if it's fatal
 *   - sendSmsSafe() swallows errors + logs — use for non-fatal notifications
 *   - formatAustralianPhone() normalises common AU formats → E.164
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Core send ────────────────────────────────────────────────────────────────
async function sendSms(toNumber, message) {
  if (!toNumber || !message) throw new Error('sendSms: toNumber and message are required');

  const key    = process.env.SINCH_API_KEY;
  const secret = process.env.SINCH_API_SECRET;
  const sender = process.env.SINCH_SENDER_ID;

  if (!key || !secret) throw new Error('sendSms: SINCH_API_KEY / SINCH_API_SECRET not set');

  const auth = Buffer.from(`${key}:${secret}`).toString('base64');

  const res = await fetch('https://api.messagemedia.com/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      messages: [{
        content:            message,
        destination_number: toNumber,
        source_number:      sender || undefined,
        format:             'SMS',
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sinch MessageMedia send failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  console.log(`GeneThrive SMS: sent to ${toNumber} — message_id: ${data?.messages?.[0]?.message_id || 'n/a'}`);
  return data;
}

// ── Non-fatal wrapper ─────────────────────────────────────────────────────────
// Use this when an SMS failure must NOT break the order flow.
async function sendSmsSafe(toNumber, message, context) {
  try {
    return await sendSms(toNumber, message);
  } catch (err) {
    console.error(`GeneThrive SMS: failed${context ? ` (${context})` : ''} to ${toNumber} — ${err.message}`);
    return null;
  }
}

// ── Phone number formatter ────────────────────────────────────────────────────
// Normalises common Australian mobile formats to E.164.
// e.g. "0412 345 678" → "+61412345678"
//      "04-12-345-678" → "+61412345678"
//      "+61412345678" → "+61412345678" (already correct)
function formatAustralianPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');           // strip non-digits
  if (digits.startsWith('61') && digits.length === 11) return `+${digits}`;   // +61...
  if (digits.startsWith('0')  && digits.length === 10) return `+61${digits.slice(1)}`; // 04...
  if (digits.length === 9)                              return `+61${digits}`;  // 4...
  return `+${digits}`;  // fallback — pass through with +
}

module.exports = { sendSms, sendSmsSafe, formatAustralianPhone };
