// GeneThrive — adapted for order_sla table (was: client_pipeline)
// Netlify Function: netlify/functions/check-sla-breaches.js
//
// SCHEDULED function — run every 15–60 minutes via Netlify scheduled function.
// Netlify config (netlify.toml):
//
//   [functions.check-sla-breaches]
//     schedule = "*/30 * * * *"
//
// Why a scheduled check: "day 7 with no swab returned" is a fact about TIME
// PASSING, not a database edit — nothing triggers a webhook at that exact
// moment. This function notices. It reads every active order, recomputes SLA
// status using the same logic as Paul's dashboard, and writes a one-row patch
// only when a threshold is FRESHLY crossed. That UPDATE fires the Supabase
// Database Webhook → notify-on-change.js → Sinch SMS.
//
// ENVIRONMENT VARIABLES (Netlify dashboard → Site → Environment variables):
//   SUPABASE_URL              your Supabase project URL
//   SUPABASE_SERVICE_KEY      service_role key (NOT the anon key — needs write
//                              access across all rows; never put in client code)
//
// Original file by Paul's Claude/Cowork — adapted column/table names only.
// SLA logic is unchanged from sla-logic.js.

const { statusFor } = require('./sla-logic');

// ── Table and column mapping ─────────────────────────────────────────────────
// Edit ONLY this block if your schema changes — everything below stays the same.
const TABLE = 'order_sla';                        // was: client_pipeline
const COLUMNS = {
  id:                 'client_id',                // was: client_ref
  stage:              'current_stage',            // same concept, new table
  stageEnteredAt:     'stage_entered_at',         // same concept, new table
  swabReceivedAt:     'swab_returned_at',         // was: swab_received_at
  swabReminderSentAt: 'swab_reminder_sent_at',    // unchanged
  lastAlertStatus:    'last_alert_status',        // unchanged
  clientPhone:        'client_phone',             // unchanged
};

// ── Supabase REST helper ─────────────────────────────────────────────────────
async function supabaseRequest(path, options) {
  const url = `${process.env.SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey:          process.env.SUPABASE_SERVICE_KEY,  // was: SUPABASE_SERVICE_ROLE_KEY
      Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      Prefer:          'return=representation',
      ...(options && options.headers),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase request failed (${res.status}): ${body}`);
  }
  return res.json();
}

// ── Main logic ───────────────────────────────────────────────────────────────
async function run() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY environment variables.');
  }

  // Fetch all active (non-shipped) orders that have a current_stage set
  const rows = await supabaseRequest(
    `/${TABLE}?${COLUMNS.stage}=neq.shipped&${COLUMNS.stage}=not.is.null&select=*`,
    { method: 'GET' }
  );

  const now = new Date();
  let updated = 0;

  for (const row of rows) {
    const client = {
      id:            row[COLUMNS.id],
      stage:         row[COLUMNS.stage],
      stageEnteredAt: row[COLUMNS.stageEnteredAt],
    };

    // Skip rows where stage_entered_at is missing (shouldn't happen after migration)
    if (!client.stageEnteredAt) continue;

    const { status } = statusFor(client, now);
    const previousStatus = row[COLUMNS.lastAlertStatus] || 'good';

    const patch = {};

    // Swab-return client reminder: fire exactly once, the first time this row
    // is checked after crossing into breach, only if swab genuinely not back.
    if (
      client.stage === 'swab_return' &&
      !row[COLUMNS.swabReceivedAt] &&
      !row[COLUMNS.swabReminderSentAt] &&
      status === 'crit'
    ) {
      patch[COLUMNS.swabReminderSentAt] = now.toISOString();
    }

    // Generic breach/approach transition — picked up by notify-on-change.js
    // to SMS Paul. Only patches when status has actually changed.
    if (status !== previousStatus) {
      patch[COLUMNS.lastAlertStatus] = status;
    }

    if (Object.keys(patch).length > 0) {
      await supabaseRequest(
        `/${TABLE}?${COLUMNS.id}=eq.${encodeURIComponent(client.id)}`,
        { method: 'PATCH', body: JSON.stringify(patch) }
      );
      updated += 1;
      console.log(`GeneThrive SLA: patched ${client.id} → stage=${client.stage} status=${status}`);
    }
  }

  return { checked: rows.length, updated };
}

// ── Netlify scheduled function entry point ───────────────────────────────────
exports.handler = async () => {
  try {
    const result = await run();
    console.log(`[check-sla-breaches] checked ${result.checked} rows, updated ${result.updated}`);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('[check-sla-breaches] error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Allow `node check-sla-breaches.js` for a manual/local run
if (require.main === module) {
  run().then(r => console.log(r)).catch(e => { console.error(e); process.exit(1); });
}