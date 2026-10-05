/**
 * GeneThrive — emails TSI Compounding Pharmacy the order number and client
 * details once Barbara has signed off, and starts the 48-hour ack SLA clock.
 * This is the "email to Compounding Pharmacy with order number and client
 * details" step from Paul's logistics flow document.
 *
 * Deliberately does NOT attach or include the clinical rationale (genes,
 * evidence, dosing reasoning) — TSI needs the same pharmacy-facing content
 * the Engine's own openCompoundingScript() already produces (order number,
 * client details, supplement list, safety flags; no gene names, no evidence
 * tables — see that function's own header comment in the Engine). The actual
 * compounding script content is generated client-side by Barbara's browser,
 * same as the client document — this function's job is only the email +
 * SLA + payout wiring around that document, not regenerating its content.
 *
 * POST { orderRef, scriptDocumentUrl, pharmacyEmail? }
 *   scriptDocumentUrl — wherever the generated Compounding Script HTML/PDF
 *   for this order has been stored (e.g. Supabase Storage signed URL). This
 *   function does not generate that document; see generate-real-client-report.js
 *   pattern (openCompoundingScript() instead of openClientCopy()) for how to
 *   produce it, and README_for_Neveen.md's "still needed" list — the Engine
 *   currently has no automatic upload step for that output either.
 *
 * WHAT THIS DOES:
 *   1. Emails TSI (to pharmacyEmail, or TSI_COMPOUNDING_EMAIL env var) with
 *      the order reference, client name/address, and a link to the script.
 *   2. Updates compounding_scripts.emailed_to_tsi_at.
 *   3. Inserts status_events 'script.sent'.
 *   4. Starts an sla_clocks 'handoff_tsi_48h' clock (due 48h from now) — see
 *      check-overdue-sla-clocks.js, which is what actually flags it red if
 *      TSI hasn't acknowledged in time.
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY, and
 * (optional — see notify.js) RESEND_API_KEY/RESEND_FROM_EMAIL, plus
 * TSI_COMPOUNDING_EMAIL if pharmacyEmail isn't passed per-request.
 */
const { selectByColumn, insertRow, upsertRow } = require('./_lib/supabase-rest');
const { sendEmail } = require('./_lib/notify');

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

  const { orderRef, scriptDocumentUrl } = body;
  const pharmacyEmail = body.pharmacyEmail || process.env.TSI_COMPOUNDING_EMAIL;
  if (!orderRef || !scriptDocumentUrl) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'orderRef and scriptDocumentUrl are both required' }) };
  }
  if (!pharmacyEmail) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'pharmacyEmail is required (or set TSI_COMPOUNDING_EMAIL)' }) };
  }

  try {
    const orders = await selectByColumn('orders', 'order_ref', orderRef);
    if (orders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown orderRef' }) };
    }
    const order = orders[0];
    const contacts = await selectByColumn('client_contacts', 'id', order.client_contact_id);
    const contact = contacts[0] || {};
    const sentAt = new Date().toISOString();

    const emailResult = await sendEmail({
      to: pharmacyEmail,
      subject: 'GeneThrive compounding order — ' + orderRef,
      text:
        'New compounding order from GeneThrive.\n\n' +
        'Order reference: ' + orderRef + '\n' +
        'Client: ' + [contact.first_name, contact.last_name].filter(Boolean).join(' ') + '\n' +
        'Delivery address: ' + [contact.addr_street, contact.addr_suburb, contact.addr_state, contact.addr_postcode].filter(Boolean).join(', ') + '\n\n' +
        'Compounding script: ' + scriptDocumentUrl + '\n\n' +
        'Please acknowledge receipt within 48 hours via the link included in this order\'s pharmacy portal entry.',
    });

    await upsertRow(
      'compounding_scripts',
      { order_id: order.id, signed_payload_ref: scriptDocumentUrl, emailed_to_tsi_at: sentAt },
      'order_id'
    );
    await insertRow('status_events', {
      order_id: order.id,
      step_key: 'script.sent',
      actor_role: 'naturopath',
      occurred_at: sentAt,
      meta: { pharmacyEmail, emailSimulated: !emailResult.ok },
    });
    const dueAt = new Date(new Date(sentAt).getTime() + 48 * 3600 * 1000).toISOString();
    await insertRow('sla_clocks', {
      order_id: order.id,
      clock_key: 'handoff_tsi_48h',
      started_at: sentAt,
      due_at: dueAt,
      state: 'green',
    });
    await insertRow('notifications', {
      order_id: order.id,
      channel: 'email',
      template_key: 'compounding_order_sent_to_pharmacy',
      to_role: 'tsi',
      sent_at: emailResult.ok ? sentAt : null,
      body_redacted: 'Compounding order ' + orderRef + ' emailed to TSI' + (emailResult.ok ? '' : ' (SIMULATED — email provider not configured: ' + emailResult.reason + ')'),
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, orderRef, emailSent: emailResult.ok, emailSimulated: !!emailResult.simulated, slaClockDueAt: dueAt }),
    };
  } catch (err) {
    console.error('send-compounding-order-to-pharmacy: failed:', err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Storage failure' }) };
  }
};
