/**
 * GeneThrive — the actual Supabase write for a client's DNA extract, factored
 * out of save-dna-result.js so both the existing manual/API upload path AND
 * the new NutriPath inbound-email path (nutripath-inbound-email.js) go
 * through exactly one write implementation. Behaviour is unchanged from what
 * save-dna-result.js did before this refactor — see its own header comment
 * for the full rationale (results.landed status event + retrieve_results_48h
 * SLA clock, both fired here).
 */
const { selectByColumn, insertRow, upsertRow } = require('./supabase-rest');

/**
 * @param {string} clientId  orders.order_ref, e.g. "GT-2026-0002"
 * @param {object} dna       a genethrive.dna.v1 extract ({schema, variants: [...], ...})
 * @returns {{ok:true, clientId:string, dnaVariantCount:number} | {ok:false, statusCode:number, error:string}}
 */
async function writeDnaResultForOrder(clientId, dna) {
  if (!clientId) return { ok: false, statusCode: 400, error: 'Missing clientId' };
  if (!dna || dna.schema !== 'genethrive.dna.v1' || !Array.isArray(dna.variants)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'dna must be a genethrive.dna.v1 extract with a variants array (the same shape importDnaExtract() in the Engine expects)',
    };
  }

  const existingOrders = await selectByColumn('orders', 'order_ref', clientId);
  if (existingOrders.length === 0) {
    return { ok: false, statusCode: 404, error: 'No matching order found' };
  }
  const order = existingOrders[0];
  const receivedAt = new Date().toISOString();

  await upsertRow(
    'dna_results',
    {
      order_id: order.id,
      panel_meta: { lab: dna.lab || null, barcode: dna.barcode || null, reportDate: dna.reportDate || null, sourcePdf: dna.sourcePdf || null },
      results_json: dna,
      received_at: receivedAt,
    },
    'order_id'
  );

  await insertRow('status_events', {
    order_id: order.id,
    step_key: 'results.landed',
    actor_role: 'lab_system',
    occurred_at: receivedAt,
    meta: { variantCount: dna.variants.length },
  });

  const dueAt = new Date(new Date(receivedAt).getTime() + 48 * 3600 * 1000).toISOString();
  await insertRow('sla_clocks', {
    order_id: order.id,
    clock_key: 'retrieve_results_48h',
    started_at: receivedAt,
    due_at: dueAt,
    state: 'green',
  });

  return { ok: true, clientId: order.order_ref, dnaVariantCount: dna.variants.length };
}

module.exports = { writeDnaResultForOrder };
