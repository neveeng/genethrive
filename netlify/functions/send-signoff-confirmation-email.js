/**
 * GeneThrive — emails Barbara a confirmation the moment she fully signs off
 * on a client's protocol, with links to everything from that session: the
 * DNA extract, the health profile/intake, and the generated documents.
 * This is Paul's "automated email to Barbara on full sign-off (all
 * documents + DNA PDF + intake form)" request.
 *
 * Triggered by whatever calls this after inserting a protocol_signoffs row
 * with decision='agree' (the Portal's sign-off action) — this function does
 * not itself decide when sign-off happened, it only reacts to it, matching
 * the pattern of every other function in this project never re-deciding a
 * clinical judgment.
 *
 * WHY THESE ARE LINKS, NOT ATTACHMENTS: the locked schema stores JSON
 * payloads (health_profiles.payload, dna_results.results_json), not binary
 * files — there is no stored PDF/HTML blob anywhere yet to attach. Once
 * generated documents are uploaded to Supabase Storage (still an open item —
 * see README_for_Neveen.md), swap documentUrls' values for real signed
 * Storage URLs; the function already accepts them as plain strings, so no
 * further code change is needed here when that lands.
 *
 * POST { orderRef, barbaraEmail?, documentUrls?: { dnaPdf?, intakeForm?, clientCopy?, practitionerCopy?, compoundingScript? } }
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY, and
 * (optional — see notify.js) RESEND_API_KEY/RESEND_FROM_EMAIL.
 */
const { selectByColumn, insertRow } = require('./_lib/supabase-rest');
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

  const { orderRef, documentUrls } = body;
  const barbaraEmail = body.barbaraEmail || process.env.BARBARA_NOTIFY_EMAIL;
  if (!orderRef) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'orderRef is required' }) };
  }
  if (!barbaraEmail) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'barbaraEmail is required (or set BARBARA_NOTIFY_EMAIL)' }) };
  }

  try {
    const orders = await selectByColumn('orders', 'order_ref', orderRef);
    if (orders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown orderRef' }) };
    }
    const order = orders[0];
    const links = documentUrls || {};
    const lines = [
      'You\'ve fully signed off on this client\'s protocol — here\'s everything from this session.',
      '',
      'Order reference: ' + orderRef,
      links.dnaPdf ? 'DNA extract: ' + links.dnaPdf : null,
      links.intakeForm ? 'Intake / health profile: ' + links.intakeForm : null,
      links.clientCopy ? 'Client copy ("Your DNA, Your Supplements Explained"): ' + links.clientCopy : null,
      links.practitionerCopy ? 'Practitioner copy: ' + links.practitionerCopy : null,
      links.compoundingScript ? 'Compounding script: ' + links.compoundingScript : null,
    ].filter(Boolean);

    const sentAt = new Date().toISOString();
    const emailResult = await sendEmail({
      to: barbaraEmail,
      subject: 'GeneThrive — sign-off confirmed for ' + orderRef,
      text: lines.join('\n'),
    });

    await insertRow('notifications', {
      order_id: order.id,
      channel: 'email',
      template_key: 'signoff_confirmation_to_barbara',
      to_role: 'naturopath',
      sent_at: emailResult.ok ? sentAt : null,
      body_redacted: 'Sign-off confirmation email to Barbara for ' + orderRef + (emailResult.ok ? '' : ' (SIMULATED — ' + emailResult.reason + ')'),
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, orderRef, emailSent: emailResult.ok, emailSimulated: !!emailResult.simulated }),
    };
  } catch (err) {
    console.error('send-signoff-confirmation-email: failed:', err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Storage failure' }) };
  }
};
