/**
 * GeneThrive — ops requests moving a client's assigned practitioner (e.g.
 * Barbara is unavailable, a backup naturopath needs to take over). This ONLY
 * creates a pending request — see approve-naturopath-transfer.js for the
 * actual handover, which is deliberately a separate, explicit step.
 *
 * POST { orderRef, toPractitionerId, requestedByProfileId?, notes? }
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 */
const { selectByColumn, insertRow } = require('./_lib/supabase-rest');

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { orderRef, toPractitionerId, requestedByProfileId, notes } = body;
  if (!orderRef || !toPractitionerId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'orderRef and toPractitionerId are both required' }) };
  }

  try {
    const orders = await selectByColumn('orders', 'order_ref', orderRef);
    if (orders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown orderRef' }) };
    }
    const order = orders[0];

    const request = await insertRow('naturopath_transfer_requests', {
      order_id: order.id,
      from_practitioner_id: order.assigned_practitioner_id || null,
      to_practitioner_id: toPractitionerId,
      requested_by: requestedByProfileId || null,
      status: 'pending',
      notes: notes || null,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, requestId: request.id, status: 'pending' }),
    };
  } catch (err) {
    console.error('request-naturopath-transfer: failed:', err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Storage failure' }) };
  }
}
