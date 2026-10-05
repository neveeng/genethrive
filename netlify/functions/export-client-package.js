/**
 * GeneThrive — Barbara's "save/download this client's data to my own
 * computer" endpoint. Returns one JSON bundle with everything
 * get-client-full-record.js has, plus the raw DNA/intake payloads, so the
 * Portal's front-end can offer a single "Download" button (a `Blob` +
 * `<a download>` in the browser — a two-line front-end change once the
 * Portal is live; not built here since it's UI, not a backend endpoint).
 *
 * GET ?clientId=GT-2026-0002
 * Requires a valid practitioner session token once REQUIRE_PRACTITIONER_TOKEN
 * is turned on — see _lib/require-session.js. Left off by default, matching
 * every other function in this project today.
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY.
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

  const clientId = (event.queryStringParameters || {}).clientId;
  if (!clientId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing clientId query parameter' }) };
  }

  try {
    const orderRows = await selectByColumn('orders', 'order_ref', clientId);
    const order = orderRows[0];
    if (!order) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown clientId' }) };
    }
    const [contactRows, healthProfileRows, dnaResultRows, signoffRows] = await Promise.all([
      selectByColumn('client_contacts', 'id', order.client_contact_id),
      selectByColumn('health_profiles', 'order_id', order.id),
      selectByColumn('dna_results', 'order_id', order.id),
      selectByColumn('engine_sessions', 'order_id', order.id),
    ]);

    const bundle = {
      exportedAt: new Date().toISOString(),
      clientId: order.order_ref,
      contact: contactRows[0] || null,
      healthProfile: healthProfileRows[0] ? healthProfileRows[0].payload : null,
      rawWizardRecord: healthProfileRows[0] ? healthProfileRows[0].raw_wizard_record : null,
      dnaResults: dnaResultRows[0] ? dnaResultRows[0].results_json : null,
      dnaPanelMeta: dnaResultRows[0] ? dnaResultRows[0].panel_meta : null,
      engineSessions: signoffRows,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="' + clientId + '_export.json"',
      },
      body: JSON.stringify(bundle, null, 2),
    };
  } catch (err) {
    console.error('export-client-package: failed:', err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Lookup failure' }) };
  }
}
