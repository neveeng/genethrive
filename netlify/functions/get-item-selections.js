/**
 * GeneThrive — reads back Barbara's saved Accept/Reject/Pending decisions
 * for one Engine session, in exactly the shape
 * generate-real-client-report.js's --selections file expects
 * (see GeneThrive_README.md):
 *
 *   { "<itemKey>": "accepted" | "rejected" | "pending", ... }
 *
 * Two real uses for this:
 *   1. The report generator can fetch this instead of a hand-built local
 *      file — the real production path once this is deployed.
 *   2. The Engine's Practitioner Copy, on open, can call this to restore
 *      Barbara's previous decisions for a client she's returning to,
 *      instead of every candidate resetting to 'pending' on every reload
 *      (today's behaviour, since nothing was ever saved at all).
 *
 * GET /.netlify/functions/get-item-selections?sessionId=<uuid>
 */
const { selectByColumn } = require('./_lib/supabase-rest');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sessionId = event.queryStringParameters && event.queryStringParameters.sessionId;
  if (!sessionId) {
    return { statusCode: 400, body: 'sessionId query parameter is required' };
  }

  try {
    const rows = await selectByColumn(
      'protocol_candidates',
      'session_id',
      sessionId,
      'item_key,selection_state'
    );
    const selections = {};
    rows.forEach((r) => {
      selections[r.item_key] = r.selection_state || 'pending';
    });
    return { statusCode: 200, body: JSON.stringify(selections) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(e.message || e) }) };
  }
};
