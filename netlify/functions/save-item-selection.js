/**
 * GeneThrive — saves ONE of Barbara's Accept/Reject/Pending decisions.
 *
 * Added 28/29 Sep 2026 to close the single biggest gap found in the 28 Sep
 * audit: the Engine's own recordItemSelection() (inside the Practitioner
 * Copy's srcdoc iframe) only ever wrote to an in-memory object
 * (_itemSelections / iframeItemSelections) — nothing persisted it anywhere,
 * so it vanished the moment the tab closed. This function is the missing
 * write side: call it once per decision, and it survives.
 *
 * This does NOT decide anything clinically — it stores exactly what
 * Barbara clicked, nothing more. The Engine's own isItemAccepted() logic
 * (only 'accepted' counts) is unchanged and untouched by this file.
 *
 * Expects POST JSON:
 *   {
 *     sessionId: "<engine_sessions.id, a uuid>",
 *     itemKey:   "<the Engine's own itemSelectionId(item) string>",
 *     state:     "accepted" | "rejected" | "pending",
 *     practitionerId: "<practitioners.id, a uuid>"   // optional but recommended
 *   }
 *
 * On success, upserts protocol_candidates (session_id, item_key) with the
 * new selection_state/decided_by/decided_at — see
 * supabase_schema_addendum_28Sep2026_item_selections.sql, which MUST be
 * applied before this function is deployed (it writes to columns that
 * addendum adds).
 *
 * NOT YET WIRED TO THE ENGINE UI. This function exists and is correct, but
 * nothing in the Engine's Practitioner Copy calls it yet — that's the next
 * piece: recordItemSelection() needs a fetch() to this endpoint added
 * alongside its existing in-memory write. See README_for_Neveen.md,
 * "Wiring this into the Engine" for exactly where.
 */
import { upsertRow } from './_lib/supabase-rest';

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  const { sessionId, itemKey, state, practitionerId } = body;

  if (!sessionId || !itemKey) {
    return { statusCode: 400, body: 'sessionId and itemKey are both required' };
  }
  if (state !== 'accepted' && state !== 'rejected' && state !== 'pending') {
    return { statusCode: 400, body: 'state must be exactly "accepted", "rejected", or "pending"' };
  }

  try {
    const row = await upsertRow(
      'protocol_candidates',
      {
        session_id: sessionId,
        item_key: itemKey,
        session_item_key: sessionId + '::' + itemKey, // real Supabase derives this itself (generated column); the mock test double does not, so we set it explicitly for both
        selection_state: state,
        decided_by: practitionerId || null,
        decided_at: new Date().toISOString(),
      },
      'session_item_key'
    );
    return { statusCode: 200, body: JSON.stringify({ ok: true, row }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(e.message || e) }) };
  }
}
