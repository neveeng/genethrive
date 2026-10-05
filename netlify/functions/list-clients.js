/**
 * GeneThrive — list-clients: lightweight client list for BARBARA'S PORTAL
 * (a naturopath-scoped view — NOT the ops Chain Oversight dashboard)
 * =============================================================================
 *
 * WHY THIS FUNCTION IS ALLOWED TO TOUCH CLINICAL TABLES AT ALL
 *   The locked schema's RLS rule (supabase_schema.sql §3, checklist §3) is
 *   that the `ops` role can never SELECT health_profiles/dna_results. This
 *   function is NOT for ops — it is Barbara's own portal (`barbara_portal.html`),
 *   the naturopath-scoped view the checklist's role table (§1) explicitly
 *   allows to read clinical content for her ASSIGNED clients. The ops-facing
 *   equivalent — "who's where in the pipeline, status only" — is served
 *   directly from Supabase to the browser via the `client_pipeline` VIEW
 *   (see supabase_schema.sql), which this project's Chain Oversight dashboard
 *   already reads with the Supabase anon key + RLS; it does NOT go through
 *   any Netlify function, and nothing in this file is used by it. Do not
 *   repurpose this function for the ops dashboard — it deliberately returns
 *   dnaReady/healthProfileReady booleans derived FROM the clinical tables,
 *   which ops must never receive even as a derived boolean, per checklist §5
 *   ("no clinical joins for ops").
 *
 * WHAT CHANGED IN THIS RECONCILIATION
 *   This used to read the old ad hoc `clients` table directly. It now reads
 *   `orders` joined (as two REST calls, PostgREST-embed-free, matching this
 *   project's existing style) to `client_contacts` (for the name) and checks
 *   for the EXISTENCE of a matching `health_profiles` / `dna_results` row
 *   (never their content) to compute the same two ready/pending booleans the
 *   portal already renders.
 *
 * RESPONSE SHAPE (UNCHANGED from before this reconciliation, deliberately —
 * see CHANGELOG.md "barbara_portal.html did not need to change"):
 *   200 + JSON array, one entry per order:
 *     { clientId, name, intakeCompleted, dnaReady, healthProfileReady }
 *
 * NOTE ON AUTH (STILL A REAL, FLAGGED GAP — see CHANGELOG.md "Unverified")
 *   Per the existing Barbara Portal design, the PIN gate lives client-side in
 *   barbara_portal.html; there is no real Supabase Auth session for Barbara
 *   yet (checklist Phase A "Barbara can log in" is not done — Decisions
 *   Locked confirms no live Supabase project exists at all yet). This
 *   function therefore still authenticates to Supabase with the
 *   SERVICE ROLE key (bypassing RLS entirely) rather than as Barbara's own
 *   JWT, exactly like the function it replaces did. Once real Supabase Auth
 *   exists for Barbara, this function should instead forward her session's
 *   JWT to PostgREST (as the `Authorization` header) and let the
 *   naturopath-scoped RLS policies in supabase_schema.sql do the filtering
 *   for real, rather than this function's own service-role-privileged code
 *   being the only thing standing in for that boundary. Flagged, not hidden.
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 *
 * [29 Sep 2026] Now goes through require-session.js — enforced only once
 * REQUIRE_PRACTITIONER_TOKEN=true is set (default off, no behaviour change
 * until that flag and the real PIN-hash/session-secret env vars are set —
 * see authenticate-practitioner.js). This is a real, partial fix for the
 * auth gap this file's own header already flagged above — it stops an
 * outsider calling this endpoint directly without a valid session, though
 * the fuller fix (forwarding Barbara's own JWT so RLS itself does the
 * filtering) is the separate, bigger workstream this header already named.
 */

const { selectAll, selectByColumn } = require('./_lib/supabase-rest');
const { requireSession } = require('./_lib/require-session');

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const session = requireSession(event);
  if (!session.ok) {
    return { statusCode: session.statusCode, body: JSON.stringify({ ok: false, error: session.error }) };
  }

  try {
    const orders = await selectAll('orders');

    const clients = await Promise.all(
      orders.map(async function (order) {
        const [contactRows, healthProfileRows, dnaResultRows] = await Promise.all([
          selectByColumn('client_contacts', 'id', order.client_contact_id),
          selectByColumn('health_profiles', 'order_id', order.id),
          selectByColumn('dna_results', 'order_id', order.id),
        ]);
        const contact = contactRows[0] || {};
        const healthProfile = healthProfileRows[0] || null;
        return {
          clientId: order.order_ref,
          name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
          intakeCompleted: !!(healthProfile && healthProfile.completed_at),
          dnaReady: dnaResultRows.length > 0,
          healthProfileReady: !!(healthProfile && healthProfile.completed_at),
        };
      })
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clients),
    };
  } catch (err) {
    console.error('list-clients: Supabase select failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Lookup failure' }) };
  }
};
