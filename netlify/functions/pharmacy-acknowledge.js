/**
 * GeneThrive — TSI calls this (a link/form in the email
 * send-compounding-order-to-pharmacy.js sends them) to confirm receipt of a
 * compounding order and state their invoice amount. This is what completes
 * the 48-hour ack SLA clock, triggers TSI's payout, and texts the client
 * their order is progressing — three of the remaining pieces from Paul's
 * logistics flow in one real, tested chain.
 *
 * POST { orderRef, invoiceCents }
 *
 * WHAT THIS DOES, IN ORDER:
 *   1. Records compounding_scripts.acknowledged_at / acknowledged_invoice_cents.
 *   2. Inserts status_events 'script.received_by_tsi' (the exact step_key the
 *      locked schema already reserved for this moment).
 *   3. Marks the 'handoff_tsi_48h' sla_clocks row acknowledged.
 *   4. Creates a payouts row for TSI (payee='tsi') at the stated invoice
 *      amount and calls payment-provider.js to actually pay it — see that
 *      file for why this simulates until a real provider is chosen.
 *   5. Texts the client (best-effort) that their supplements are being
 *      prepared — the "automated text to client" step from Paul's flow.
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY, and
 * optionally SINCH_* (see notify.js) / PAYOUT_PROVIDER (see payment-provider.js).
 */
const { selectByColumn, insertRow, updateByColumn } = require('./_lib/supabase-rest');
const { sendSms } = require('./_lib/notify');
const { payPayee } = require('./_lib/payment-provider').default;

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { orderRef, invoiceCents } = body;
  if (!orderRef || invoiceCents == null) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'orderRef and invoiceCents are both required' }) };
  }

  try {
    const orders = await selectByColumn('orders', 'order_ref', orderRef);
    if (orders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown orderRef' }) };
    }
    const order = orders[0];
    const ackAt = new Date().toISOString();

    await updateByColumn('compounding_scripts', 'order_id', order.id, {
      acknowledged_at: ackAt,
      acknowledged_invoice_cents: invoiceCents,
    });

    await insertRow('status_events', {
      order_id: order.id,
      step_key: 'script.received_by_tsi',
      actor_role: 'compounder_system',
      occurred_at: ackAt,
      meta: { invoiceCents },
    });

    const clocks = await selectByColumn('sla_clocks', 'order_id', order.id);
    const handoffClock = clocks.find((c) => c.clock_key === 'handoff_tsi_48h' && !c.acknowledged_at);
    if (handoffClock) {
      await updateByColumn('sla_clocks', 'id', handoffClock.id, { acknowledged_at: ackAt, state: 'green' });
    }

    const payoutResult = await payPayee({ payee: 'tsi', amountCents: invoiceCents, orderRef, reference: 'script.received_by_tsi:' + order.id });
    await insertRow('payouts', {
      order_id: order.id,
      payee: 'tsi',
      trigger_event: 'script.received_by_tsi',
      amount_cents: invoiceCents,
      paid_at: payoutResult.ok && !payoutResult.simulated ? ackAt : null,
    });

    const contacts = await selectByColumn('client_contacts', 'id', order.client_contact_id);
    const contact = contacts[0];
    let smsResult = { ok: false, simulated: true, reason: 'no client mobile on file' };
    if (contact && contact.mobile) {
      smsResult = await sendSms({
        to: contact.mobile,
        body: 'GeneThrive: great news — your personalised supplements are now being prepared by our compounding pharmacy. We\'ll text you again once they ship.',
      });
      await insertRow('notifications', {
        order_id: order.id,
        channel: 'sms',
        template_key: 'compounding_in_progress',
        to_role: 'client',
        sent_at: smsResult.ok ? ackAt : null,
        body_redacted: 'Compounding-in-progress SMS' + (smsResult.ok ? '' : ' (SIMULATED — ' + smsResult.reason + ')'),
      });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        orderRef,
        payoutSimulated: !!payoutResult.simulated,
        clientSmsSent: smsResult.ok,
        clientSmsSimulated: !!smsResult.simulated,
      }),
    };
  } catch (err) {
    console.error('pharmacy-acknowledge: failed:', err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Storage failure' }) };
  }
};