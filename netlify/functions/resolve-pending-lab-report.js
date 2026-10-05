/**
 * GeneThrive — completes a NutriPath report that nutripath-inbound-email.js
 * filed for manual review: takes the practitioner's confirmed clientId and
 * genethrive.dna.v1 mapping, writes it through the exact same path
 * save-dna-result.js uses, then marks the pending_lab_reports row resolved.
 *
 * This is the other half of the manual-review loop — without this, "needs
 * manual review" would be a dead end. With it, ingestion is: email arrives ->
 * safely stored -> Barbara/ops confirm the mapping once -> written into
 * dna_results through the same trusted path as every other DNA import in
 * this project.
 *
 * POST { pendingLabReportId, clientId, dna, resolvedBy? }
 *   dna must be a genethrive.dna.v1 extract, same shape save-dna-result.js
 *   already validates. resolvedBy is an optional practitioners.id for the
 *   audit trail.
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 */
import { selectByColumn, updateByColumn } from './_lib/supabase-rest';
import { writeDnaResultForOrder } from './_lib/write-dna-result';

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

  const { pendingLabReportId, clientId, dna, resolvedBy } = body;
  if (!pendingLabReportId || !clientId || !dna) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'pendingLabReportId, clientId, and dna are all required' }) };
  }

  try {
    const rows = await selectByColumn('pending_lab_reports', 'id', pendingLabReportId);
    if (rows.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown pendingLabReportId' }) };
    }
    if (rows[0].status === 'resolved') {
      return { statusCode: 409, body: JSON.stringify({ ok: false, error: 'This report was already resolved' }) };
    }

    const writeResult = await writeDnaResultForOrder(clientId, dna);
    if (!writeResult.ok) {
      return { statusCode: writeResult.statusCode, body: JSON.stringify({ ok: false, error: writeResult.error }) };
    }

    await updateByColumn('pending_lab_reports', 'id', pendingLabReportId, {
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolved_by: resolvedBy || null,
      order_ref: clientId,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, clientId: writeResult.clientId, dnaVariantCount: writeResult.dnaVariantCount }),
    };
  } catch (err) {
    console.error('resolve-pending-lab-report: failed:', err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Storage failure' }) };
  }
}
