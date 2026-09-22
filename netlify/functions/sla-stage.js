/**
 * GeneThrive — SLA stage helper
 * netlify/functions/sla-stage.js
 *
 * Call advanceStage(clientId, stageName) from any Netlify function
 * whenever a client moves to a new stage. This writes current_stage
 * and stage_entered_at to order_sla so check-sla-breaches.js has
 * what it needs to compute SLA status.
 *
 * Stage values (must match sla-logic.js STAGES array):
 *   signup | health_profile | kit_dispatch | swab_return |
 *   sequencing | engine_run | barbara_review | compounding | shipped
 *
 * Usage:
 *   const { advanceStage } = require('./sla-stage');
 *   await advanceStage('GT-2026-0042', 'kit_dispatch');
 */

async function advanceStage(clientId, stage) {
  const now = new Date().toISOString();

  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/order_sla?client_id=eq.${encodeURIComponent(clientId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        current_stage:    stage,
        stage_entered_at: now,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`GeneThrive sla-stage: failed to advance ${clientId} to ${stage} — ${res.status} ${body}`);
    // Non-fatal — don't throw. SLA tracking failure shouldn't break the order flow.
  } else {
    console.log(`GeneThrive sla-stage: ${clientId} → ${stage}`);
  }
}

module.exports = { advanceStage };