/**
 * GeneThrive — submit-health-profile: saves a completed Client Health Profile
 * into the LOCKED schema's `health_profiles` table (clinical, RLS-protected)
 * =============================================================================
 *
 * WHAT CHANGED IN THIS RECONCILIATION
 *   This function used to write into `health_profile`/`raw_wizard_record`
 *   columns on the old ad hoc `clients` table. It now:
 *     1. Looks up the order by `orders.order_ref` (still called `clientId` in
 *        the wizard's own submitted JSON — see below) or `orders.intake_token`.
 *     2. Converts the wizard's record with the SAME, UNCHANGED
 *        `toEngineIntakeV1()` converter (see _lib/wizard-to-engine-intake.js —
 *        that logic was already correct; the only thing wrong was WHERE its
 *        output got stored).
 *     3. Upserts one row into `health_profiles` (order_id, payload,
 *        raw_wizard_record, completed_at) — the CLINICAL table the locked
 *        schema's RLS restricts to the assigned naturopath only; `ops` has NO
 *        policy on this table at all (see supabase_schema.sql).
 *     4. Marks `orders.status` unchanged (order status tracks
 *        paid/cancelled/refunded/completed, not intake completion).
 *     5. (27 Sep 2026) Immediately after that clinical write succeeds, ALSO
 *        inserts a `status_events` row with step_key `health_profile.completed`
 *        (order_id + occurred_at ONLY — no clinical content, exactly like
 *        `order.paid`). This is a separate, additional, ops-safe ping that
 *        lets the `client_pipeline` view move the client from the `signup`
 *        stage to the `health_profile` stage on the Chain Oversight
 *        dashboard, WITHOUT ops ever gaining visibility into the clinical
 *        `health_profiles` table itself — see supabase_schema.sql's
 *        client_pipeline comment block ("27 SEP 2026 UPDATE") for the full
 *        reasoning. This ping is best-effort: if it fails, we log and still
 *        return success, because the clinical save succeeding is what
 *        matters most — a missed dashboard tile update is recoverable, a
 *        lost health profile submission is not.
 *
 *   The wizard's OWN request-body field is still literally named `clientId`
 *   (it's baked into the wizard HTML's `buildRecord()` — see
 *   GeneThrive_ClientHealthProfile_Form_Wizard_25Sep2026.html) and still holds
 *   the human-readable "GT-2026-0001"-style reference; the only change is
 *   that this reference is now looked up against `orders.order_ref` instead
 *   of the old `clients.client_id` primary key.
 *
 * WHY UPSERT, NOT A PLAIN UPDATE
 *   health_profiles.order_id is UNIQUE (one health profile per order). A
 *   client who goes back and corrects an answer before Barbara has retrieved
 *   results should overwrite their own row, not create a second one or fail
 *   with a duplicate-key error — upsertRow() (on_conflict=order_id) handles
 *   both the first submission and any resubmission identically.
 *
 * HOW WE FIND THE RIGHT ORDER: unchanged reasoning — prefer clientId
 * (order_ref), fall back to token (intake_token), 404 rather than orphan.
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 */

const { selectByColumn, upsertRow, insertRow } = require('./_lib/supabase-rest');
const { toEngineIntakeV1 } = require('./_lib/wizard-to-engine-intake');

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let record;
  try {
    record = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const clientId = record.clientId; // still the wizard's own field name — see header comment
  const token = record.token || (event.queryStringParameters && event.queryStringParameters.token);

  if (!clientId && !token) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'Record must include clientId (or a token) to identify the order' }),
    };
  }

  try {
    let existingOrders = [];
    if (clientId) {
      existingOrders = await selectByColumn('orders', 'order_ref', clientId);
    }
    if (existingOrders.length === 0 && token) {
      existingOrders = await selectByColumn('orders', 'intake_token', token);
    }
    if (existingOrders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'No matching order found' }) };
    }
    const order = existingOrders[0];

    const engineIntake = toEngineIntakeV1(record);

    const savedRow = await upsertRow(
      'health_profiles',
      {
        order_id: order.id,
        payload: engineIntake,
        raw_wizard_record: record,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      'order_id'
    );

    // Ops-safe pipeline ping — additional, separate write; a failure here must
    // NEVER roll back or fail the request, since the clinical save above has
    // already succeeded and that's what matters most. See header comment (5).
    try {
      await insertRow('status_events', {
        order_id: order.id,
        step_key: 'health_profile.completed',
        actor_role: 'client',
        occurred_at: new Date().toISOString(),
      });
    } catch (opsEventErr) {
      console.error(
        'submit-health-profile: non-fatal — failed to write ops-visible health_profile.completed status_events row:',
        opsEventErr.message
      );
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, clientId: order.order_ref, intakeCompleted: !!savedRow.completed_at }),
    };
  } catch (err) {
    console.error('submit-health-profile: Supabase write failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Storage failure' }) };
  }
};