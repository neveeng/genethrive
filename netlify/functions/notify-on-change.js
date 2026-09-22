// notify-on-change.js
// GeneThrive — adapted for order_sla table (was: client_pipeline)
//
// WEBHOOK function — deployed as a Netlify Function.
// Wire it up in Supabase:
//   Database → Webhooks → New webhook
//   Table: order_sla   Event: Update   URL: https://YOUR-SITE.netlify.app/.netlify/functions/notify-on-change
//
// Supabase calls this automatically whenever check-sla-breaches.js (or
// anything else) changes a row in order_sla. This function sends the
// actual SMS via Sinch MessageMedia — it never polls anything itself.
//
// ENVIRONMENT VARIABLES (Netlify dashboard → Site → Environment variables):
//   SINCH_API_KEY        Sinch MessageMedia API key
//   SINCH_API_SECRET     Sinch MessageMedia API secret
//   SINCH_SENDER_ID      approved sender ID / number from Sinch
//   PAUL_PHONE_NUMBER    Paul's mobile in E.164 format, e.g. +614xxxxxxxx
//
// Original file by Paul's Claude/Cowork — adapted column names only.
// SMS logic and Sinch API calls are unchanged.

// ── Column mapping ───────────────────────────────────────────────────────────
// Edit ONLY this block if your schema changes.
const COLUMNS = {
  id:                 'client_id',                // was: client_ref
  stage:              'current_stage',            // same concept
  swabReceivedAt:     'swab_returned_at',         // was: swab_received_at
  swabReminderSentAt: 'swab_reminder_sent_at',    // unchanged
  lastAlertStatus:    'last_alert_status',        // unchanged
  clientPhone:        'client_phone',             // unchanged
};

const STAGE_LABELS = {
  signup:           'Signup & payment',
  health_profile:   'Health Profile',
  kit_dispatch:     'Kit dispatch',
  swab_return:      'Swab return',
  sequencing:       'NutriPath sequencing',
  engine_run:       'Engine run',
  barbara_review:   'Barbara review',
  compounding:      'Compounding (TSI)',
  shipped:          'Shipped',
};

// ── SMS via shared Sinch helper ──────────────────────────────────────────────
const { sendSms } = require('./sinch-sms');

// ── Handle a single row change ───────────────────────────────────────────────
async function handleChange(payload) {
  const { record, old_record: oldRecord } = payload;
  if (!record) return { sent: [] };

  const sent       = [];
  const clientId   = record[COLUMNS.id];
  const stageLabel = STAGE_LABELS[record[COLUMNS.stage]] || record[COLUMNS.stage];

  // 1. Client-facing swab-return reminder
  //    Fires the moment check-sla-breaches stamps swab_reminder_sent_at for
  //    the first time (transition from null → timestamp).
  const reminderJustSet =
    record[COLUMNS.swabReminderSentAt] &&
    (!oldRecord || !oldRecord[COLUMNS.swabReminderSentAt]);

  if (reminderJustSet && record[COLUMNS.clientPhone]) {
    await sendSms(
      record[COLUMNS.clientPhone],
      'Hi, this is a reminder from GeneThrive — we haven\'t yet received your DNA test kit back in the post. ' +
      'Please pop it in the mail as soon as you can so we can keep your results on track. ' +
      'Any trouble, just reply to this text.'
    );
    sent.push({ to: 'client', clientId, type: 'swab_reminder' });
    console.log(`GeneThrive notify: swab reminder SMS sent to client ${clientId}`);
  }

  // 2. Paul-facing SLA alert
  //    Fires whenever last_alert_status transitions to warn or crit.
  const statusJustChanged =
    record[COLUMNS.lastAlertStatus] &&
    (!oldRecord || oldRecord[COLUMNS.lastAlertStatus] !== record[COLUMNS.lastAlertStatus]);

  if (
    statusJustChanged &&
    (record[COLUMNS.lastAlertStatus] === 'crit' || record[COLUMNS.lastAlertStatus] === 'warn')
  ) {
    const word = record[COLUMNS.lastAlertStatus] === 'crit' ? 'BREACHED' : 'approaching SLA';
    await sendSms(
      process.env.PAUL_PHONE_NUMBER,
      `GeneThrive Chain Oversight: ${clientId} is ${word} at ${stageLabel}. ` +
      'Check the dashboard for details.'
    );
    sent.push({ to: 'paul', clientId, status: record[COLUMNS.lastAlertStatus] });
    console.log(`GeneThrive notify: Paul SMS sent — ${clientId} ${word} at ${stageLabel}`);
  }

  return { sent };
}

// ── Netlify function entry point (Supabase Database Webhook fires here) ───────
exports.handler = async (event) => {
  try {
    // Validate it's actually from Supabase (basic check)
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method not allowed' };
    }

    const payload = JSON.parse(event.body || '{}');

    // Only handle UPDATE events on order_sla
    if (payload.type && payload.type !== 'UPDATE') {
      return { statusCode: 200, body: JSON.stringify({ skipped: true, type: payload.type }) };
    }

    const result = await handleChange(payload);
    return { statusCode: 200, body: JSON.stringify(result) };

  } catch (err) {
    console.error('[notify-on-change] error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

module.exports.handleChange = handleChange;
