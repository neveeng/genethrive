/**
 * GeneThrive — get-client-full-record: one order's full clinical record, for
 * Barbara's "Open in Engine" handoff (naturopath-scoped, NOT ops)
 * =============================================================================
 *
 * WHY THIS FUNCTION IS ALLOWED TO RETURN CLINICAL CONTENT
 *   Same boundary as list-clients.js (read that file's header comment first).
 *   This is the ONE legitimate case the task description calls out
 *   explicitly: Barbara's "Open in Engine" button needs the client's full DNA
 *   extract and health profile JSON to stage into the existing, UNCHANGED
 *   localStorage handoff (see openInEngine() in portal/barbara_portal.html).
 *   ops must never reach this function or its data — nothing ops-facing calls
 *   it, and the ops Chain Oversight dashboard reads only `client_pipeline`
 *   directly from Supabase, never a Netlify function.
 *
 * WHAT CHANGED IN THIS RECONCILIATION
 *   Given an order_ref (GET .../get-client-full-record?clientId=GT-2026-0002),
 *   looks up `orders`, then its `client_contacts` row (identity/address) and
 *   its `health_profiles.payload` / `dna_results.results_json` rows (full
 *   clinical content — this is the one function in the project allowed to
 *   return it in full, matching the original function's own same carve-out
 *   for the old ad hoc schema's dna_results/health_profile columns).
 *
 * RESPONSE SHAPE (UNCHANGED from before this reconciliation):
 *   200 + JSON: { clientId, firstName, lastName, email, mobile,
 *     addrStreet, addrSuburb, addrState, addrPostcode, intakeCompleted,
 *     dnaResults, healthProfile }
 *   404 when clientId doesn't match any order.
 *
 * NOTE ON AUTH: same real, flagged gap as list-clients.js — this still
 * authenticates with the SERVICE ROLE key rather than a real Barbara JWT,
 * because no live Supabase project / Supabase Auth session exists yet. See
 * CHANGELOG.md "Unverified" and list-clients.js's header comment for the
 * exact follow-up this needs once a real Supabase project exists.
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 *
 * [29 Sep 2026] Now goes through require-session.js — enforced only once
 * REQUIRE_PRACTITIONER_TOKEN=true is set (default off, no behaviour change
 * until that flag and the real PIN-hash/session-secret env vars are set —
 * see authenticate-practitioner.js). This is the real fix for the auth gap
 * this file's own header already flagged above.
 */

import { selectByColumn } from './_lib/supabase-rest';
import { requireSession } from './_lib/require-session';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const session = requireSession(event);
  if (!session.ok) {
    return { statusCode: session.statusCode, body: JSON.stringify({ ok: false, error: session.error }) };
  }

  const params = (event.queryStringParameters) || {};
  const clientId = params.clientId;

  if (!clientId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing clientId query parameter' }) };
  }

  try {
    const orderRows = await selectByColumn('orders', 'order_ref', clientId);
    const order = orderRows[0];
    if (!order) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown clientId' }) };
    }

    const [contactRows, healthProfileRows, dnaResultRows] = await Promise.all([
      selectByColumn('client_contacts', 'id', order.client_contact_id),
      selectByColumn('health_profiles', 'order_id', order.id),
      selectByColumn('dna_results', 'order_id', order.id),
    ]);
    const contact = contactRows[0] || {};
    const healthProfile = healthProfileRows[0] || null;
    const dnaResult = dnaResultRows[0] || null;

    const record = {
      clientId: order.order_ref,
      firstName: contact.first_name,
      lastName: contact.last_name,
      email: contact.email,
      mobile: contact.mobile,
      addrStreet: contact.addr_street,
      addrSuburb: contact.addr_suburb,
      addrState: contact.addr_state,
      addrPostcode: contact.addr_postcode,
      intakeCompleted: !!(healthProfile && healthProfile.completed_at),
      dnaResults: dnaResult ? dnaResult.results_json : null,
      healthProfile: healthProfile ? healthProfile.payload : null,
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    };
  } catch (err) {
    console.error('get-client-full-record: Supabase lookup failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Lookup failure' }) };
  }
}
