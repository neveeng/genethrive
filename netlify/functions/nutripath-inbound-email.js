/**
 * GeneThrive — receives NutriPath's results email and files the attached lab
 * report PDF, ready for Barbara/ops to complete (see parse-nutripath-pdf.js
 * for exactly why this routes to manual review rather than auto-parsing).
 *
 * "BUILD THIS" (Paul, 28 Sep 2026) — this is the missing half of the
 * DNA-PDF-to-Supabase pipeline. save-dna-result.js already existed and
 * already correctly writes a genethrive.dna.v1 extract into Supabase; what
 * never existed anywhere in this project was a way for an EMAILED PDF to
 * become that extract. This function is that missing half.
 *
 * HOW THIS GETS TRIGGERED: configure Postmark's Inbound Webhook (or any
 * provider that posts the same JSON shape — Postmark's is simple and
 * well-documented, which is why this function targets it) to POST here.
 * Concretely: create an inbound email address in Postmark (e.g.
 * results@in.genethrive.com), point NutriPath's results delivery at that
 * address (or have someone forward to it), and set that inbound stream's
 * webhook URL to this function's deployed URL.
 *
 * EXPECTED PAYLOAD (Postmark inbound webhook shape — only the fields used
 * here are listed; Postmark sends more, all ignored):
 *   {
 *     "Subject": "...",
 *     "From": "...",
 *     "Attachments": [ { "Name": "report.pdf", "Content": "<base64>", "ContentType": "application/pdf" } ]
 *   }
 *
 * WHAT THIS FUNCTION DOES:
 *   1. Finds the first PDF attachment. No PDF attachment -> 200 (not an
 *      error — plenty of legitimate emails won't have one) with a note, so
 *      Postmark doesn't retry forever.
 *   2. Extracts its text and looks for a GT-2026-NNNN order reference in the
 *      subject, filename, or the PDF text itself (in that priority order).
 *   3. ALWAYS stores the raw report into the new `pending_lab_reports` table
 *      (see supabase_schema_addendum_29Sep2026_pending_lab_reports.sql) for
 *      manual mapping — never writes into the clinical `dna_results` table
 *      directly, because no confident automated parse exists yet (see
 *      parse-nutripath-pdf.js's header for exactly why, and what would
 *      change that).
 *   4. Emails Barbara + ops a notification that a report is waiting for
 *      manual review (best-effort — see notify.js; failure to notify does
 *      not fail the request, since the report is already safely stored).
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY, and
 * (optional — see notify.js) RESEND_API_KEY/RESEND_FROM_EMAIL for the
 * review-needed notification email. NUTRIPATH_REVIEW_NOTIFY_EMAIL sets who
 * gets that notification (defaults to not sending one if unset).
 */
import { insertRow } from './_lib/supabase-rest';
import { parseNutriPathPdf } from './_lib/parse-nutripath-pdf';
import { sendEmail } from './_lib/notify';

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

  const attachments = Array.isArray(body.Attachments) ? body.Attachments : [];
  const pdfAttachment = attachments.find(
    (a) => (a.ContentType || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(a.Name || '')
  );

  if (!pdfAttachment) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, skipped: true, reason: 'No PDF attachment on this email' }),
    };
  }

  let parseResult;
  try {
    const pdfBuffer = Buffer.from(pdfAttachment.Content, 'base64');
    parseResult = await parseNutriPathPdf(pdfBuffer, pdfAttachment.Name || body.Subject || '');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Could not read the PDF attachment: ' + e.message }) };
  }

  let stored;
  try {
    stored = await insertRow('pending_lab_reports', {
      order_ref: parseResult.orderRef,
      raw_text: parseResult.rawText,
      raw_pdf_base64: pdfAttachment.Content,
      source_email_subject: body.Subject || null,
      source_email_from: body.From || null,
      status: 'needs_manual_mapping',
    });
  } catch (e) {
    console.error('nutripath-inbound-email: failed to store pending_lab_reports row:', e.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Storage failure — the report was NOT saved, ask NutriPath to resend' }) };
  }

  const notifyTo = process.env.NUTRIPATH_REVIEW_NOTIFY_EMAIL;
  if (notifyTo) {
    try {
      await sendEmail({
        to: notifyTo,
        subject: 'GeneThrive — new NutriPath report needs manual mapping' + (parseResult.orderRef ? ' (' + parseResult.orderRef + ')' : ''),
        text:
          'A NutriPath report arrived by email and is stored, pending manual review.\n\n' +
          'Order reference detected: ' + (parseResult.orderRef || '(none found — please match by hand)') + '\n' +
          'pending_lab_reports id: ' + stored.id + '\n\n' +
          'This report was NOT written into any client\'s DNA results automatically — ' +
          'no automated parser is confident enough for clinical data yet. Please open it, ' +
          'confirm the correct client, and enter/import the variant data as usual.',
      });
    } catch (e) {
      console.error('nutripath-inbound-email: review-needed notification failed (report is still safely stored):', e.message);
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      pendingLabReportId: stored.id,
      orderRefDetected: parseResult.orderRef,
      status: 'needs_manual_mapping',
    }),
  };
}
