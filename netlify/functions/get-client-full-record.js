/**
 * GeneThrive — get-client-full-record
 * Barbara's "Open in Engine" handoff — returns full clinical record.
 * NEVER called by ops-facing code. Barbara-only.
 *
 * GET /.netlify/functions/get-client-full-record?clientId=GT-2026-0001
 *
 * ENVIRONMENT VARIABLES: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { selectByColumn } = require('./_lib/supabase-rest');
const { requireSession }  = require('./_lib/require-session');

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const session = requireSession(event);
  if (!session.ok) {
    return { statusCode: session.statusCode, body: JSON.stringify({ ok: false, error: session.error }) };
  }

  const params   = event.queryStringParameters || {};
  const clientId = params.clientId;

  if (!clientId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing clientId query parameter' }) };
  }

  try {
    const orderRows = await selectByColumn('orders', 'order_ref', clientId);
    const order     = orderRows[0];
    if (!order) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown clientId' }) };
    }

    const [contactRows, healthProfileRows, dnaResultRows] = await Promise.all([
      selectByColumn('client_contacts', 'id',       order.client_contact_id),
      selectByColumn('health_profiles', 'order_id', order.id),
      selectByColumn('dna_results',     'client_id', order.order_ref),  // ← fixed: client_id not order_id
    ]);

    const contact       = contactRows[0]      || {};
    const healthProfile = healthProfileRows[0] || null;
    const dnaResult     = dnaResultRows[0]     || null;

    const record = {
      clientId:        order.order_ref,
      firstName:       contact.first_name,
      lastName:        contact.last_name,
      email:           contact.email,
      mobile:          contact.mobile,
      addrStreet:      contact.addr_street,
      addrSuburb:      contact.addr_suburb,
      addrState:       contact.addr_state,
      addrPostcode:    contact.addr_postcode,
      intakeCompleted: !!(healthProfile && healthProfile.completed_at),
      dnaResults:      dnaResult     ? dnaResult.result_data  : null,  // ← fixed: result_data not results_json
      healthProfile:   healthProfile ? healthProfile.payload   : null,
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
};