/**
 * GeneThrive — shared email/SMS sending helper.
 *
 * Every function up to this point (shopify-order-webhook.js, save-dna-result.js,
 * etc.) only ever wrote a row into `notifications` describing what SHOULD be
 * sent — nothing in this project actually sent an email or text yet. This is
 * the real send path, built the same way supabase-rest.js was: plain fetch()
 * calls against a REST API, no SDK dependency, so it stays consistent with the
 * rest of this codebase.
 *
 * Providers (both optional, independently configurable):
 *   Email — Resend (https://resend.com). Env vars: RESEND_API_KEY, RESEND_FROM_EMAIL.
 *   SMS   — Sinch MessageMedia (https://messagemedia.com). Env vars:
 *             SINCH_API_KEY, SINCH_API_SECRET, SINCH_FROM_NUMBER.
 *           SINCH_FROM_NUMBER should be set to the approved sender ID "GeneThrive"
 *           once Sinch confirms AU alphanumeric sender approval.
 *
 * Neither provider is required to be configured. If the relevant env vars are
 * missing, sendEmail()/sendSms() do NOT throw and do NOT silently pretend to
 * succeed — they return { ok: false, simulated: true, reason: '...' } so the
 * caller can log a `notifications` row with sent_at = null and a clear
 * "provider not configured" note, exactly matching this project's existing
 * honesty pattern (see e.g. generate-real-client-report.js's DEMO-ONLY
 * warnings) rather than claiming something was sent when it wasn't.
 *
 * This is deliberately provider-swappable: if GeneThrive ends up using a
 * different email/SMS vendor, only this one file needs to change — nothing
 * else in the project talks to Resend/Sinch directly.
 */

async function sendEmail({ to, subject, html, text, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    return { ok: false, simulated: true, reason: 'RESEND_API_KEY / RESEND_FROM_EMAIL not configured' };
  }
  const payload = { from, to: Array.isArray(to) ? to : [to], subject, html: html || undefined, text: text || undefined };
  if (attachments && attachments.length) {
    // Resend expects { filename, content } where content is base64.
    payload.attachments = attachments.map((a) => ({ filename: a.filename, content: a.contentBase64 }));
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    return { ok: false, simulated: false, reason: 'Resend API error ' + res.status + ': ' + (await res.text()) };
  }
  const data = await res.json();
  return { ok: true, simulated: false, providerId: data.id || null };
}

async function sendSms({ to, body }) {
  const apiKey = process.env.SINCH_API_KEY;
  const apiSecret = process.env.SINCH_API_SECRET;
  const from = process.env.SINCH_FROM_NUMBER; // e.g. "GeneThrive" (approved AU sender ID) or a long number
  if (!apiKey || !apiSecret || !from) {
    return { ok: false, simulated: true, reason: 'SINCH_API_KEY / SINCH_API_SECRET / SINCH_FROM_NUMBER not configured' };
  }
  // Sinch MessageMedia REST API — Basic auth with API key:secret
  const res = await fetch('https://api.messagemedia.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        {
          content: body,
          destination_number: to,
          source_number: from,
          format: 'SMS',
        },
      ],
    }),
  });
  if (!res.ok) {
    return { ok: false, simulated: false, reason: 'Sinch MessageMedia API error ' + res.status + ': ' + (await res.text()) };
  }
  const data = await res.json();
  // MessageMedia returns { messages: [{ message_id, status, ... }] }
  const msgId = data.messages && data.messages[0] && data.messages[0].message_id;
  return { ok: true, simulated: false, providerId: msgId || null };
}

module.exports = { sendEmail, sendSms };