/**
 * GeneThrive — get-client-full-record
 * =============================================================================
 * Netlify Function: netlify/functions/get-client-full-record.js
 *
 * CALLED BY: barbara-portal.html → openInEngine()
 *
 * Returns a single client's full clinical record for handoff to the
 * GeneThrive Engine via the localStorage portal bridge.
 *
 * WHAT THIS RETURNS:
 *   dnaResults   → result_data.dna_extract  (genethrive.dna.v1 JSON — engine-ready)
 *   healthProfile → health_profiles.payload  (intake form JSON)
 *
 *   NOTE: The raw PDF (result_data.pdf_base64) is NOT returned — it's large
 *   and the engine doesn't need it. Only the structured dna_extract is sent.
 *
 * AUTH: requireSession() enforced when REQUIRE_PRACTITIONER_TOKEN=true.
 *       Defaults off until Barbara's PIN/session is configured.
 *
 * ENVIRONMENT VARIABLES: SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * PRIVACY: Only Barbara's portal calls this. Never exposed to Paul's dashboard.
 */

const { selectByColumn } = require('./_lib/supabase-rest');
const { requireSession }  = require('./_lib/require-session');

exports.handler = async function handler(event) {

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const session = requireSession(event);
  if (!session.ok) {
    return {
      statusCode: session.statusCode,
      body: JSON.stringify({ ok: false, error: session.error }),
    };
  }

  const params   = event.queryStringParameters || {};
  const clientId = params.clientId;

  if (!clientId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'Missing clientId query parameter' }),
    };
  }

  try {
    // Look up the order by order_ref (= the human-readable GT ref, e.g. GT-2026-0001)
    const orderRows = await selectByColumn('orders', 'order_ref', clientId);
    const order     = orderRows[0];
    if (!order) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown clientId' }) };
    }

    // Parallel fetch: contact identity, health profile, DNA results
    // dna_results keyed on client_id (= order.order_ref, NOT order.id)
    const [contactRows, healthProfileRows, dnaResultRows] = await Promise.all([
      selectByColumn('client_contacts', 'id',        order.client_contact_id),
      selectByColumn('health_profiles', 'order_id',  order.id),
      selectByColumn('dna_results',     'client_id', order.order_ref),  // ← client_id is text PK
    ]);

    const contact       = contactRows[0]       || {};
    const healthProfile = healthProfileRows[0] || null;
    const dnaResult     = dnaResultRows[0]     || null;

    // Extract only the dna_extract from result_data (NOT the raw pdf_base64)
    // dna_extract is the genethrive.dna.v1 JSON stored by nutripath-submit.js
    const dnaExtract = dnaResult && dnaResult.result_data
      ? dnaResult.result_data.dna_extract || null
      : null;

    const record = {
      clientId:        order.order_ref,
      firstName:       contact.first_name    || null,
      lastName:        contact.last_name     || null,
      email:           contact.email         || null,
      mobile:          contact.mobile        || null,
      addrStreet:      contact.addr_street   || null,
      addrSuburb:      contact.addr_suburb   || null,
      addrState:       contact.addr_state    || null,
      addrPostcode:    contact.addr_postcode || null,
      intakeCompleted: !!(healthProfile && healthProfile.completed_at),
      dnaResults:      dnaExtract,   // genethrive.dna.v1 → passed directly to engine's importDnaExtract()
      healthProfile:   healthProfile ? healthProfile.payload : null,
    };

    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'application/json' },
      body:       JSON.stringify(record),
    };

  } catch (err) {
    console.error('GeneThrive: get-client-full-record lookup failed —', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: 'Lookup failure' }),
    };
  }
};