/**
 * GeneThrive — tiny shared helper for talking to Supabase's REST API (PostgREST).
 *
 * Why this exists: every Netlify function in this project needs to read/write
 * rows in the LOCKED schema (see ../../supabase_schema.sql) — orders,
 * client_contacts, status_events, sla_clocks, health_profiles, dna_results.
 * Rather than duplicating the same fetch() calls in each file, they all share
 * this one tiny helper. It uses only the built-in `fetch` (Node 18+, which
 * Netlify Functions run on) — no npm dependency.
 *
 * Supabase's REST API is just PostgREST: every table (and view — see
 * selectAll('client_pipeline') usage elsewhere in this project) is
 * automatically exposed at {SUPABASE_URL}/rest/v1/{table}, and you talk to it
 * with normal HTTP verbs plus a couple of required headers. We only ever use
 * the SERVICE ROLE key here (never the public "anon" key), because this code
 * runs server-side in Netlify Functions and needs full read/write access,
 * bypassing RLS entirely — matching supabase_schema.sql's own comment: "the
 * six clinical writes in this project ... are exactly the kind of trusted
 * server code the checklist has in mind, never the browser."
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function assertConfigured() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_KEY must both be set as Netlify ' +
      'environment variables (Site settings -> Environment variables).'
    );
  }
}

function headers(extra) {
  return Object.assign(
    {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    extra || {}
  );
}

/**
 * Look up rows in `table` where `column` equals `value`. Returns an array
 * (empty if nothing matched). `selectClause` defaults to '*' but callers that
 * need a PostgREST embed (e.g. 'id,client_contacts(*)') can pass one.
 */
async function selectByColumn(table, column, value, selectClause) {
  assertConfigured();
  const url =
    SUPABASE_URL + '/rest/v1/' + table + '?' + column + '=eq.' + encodeURIComponent(value) +
    '&select=' + encodeURIComponent(selectClause || '*');
  const res = await fetch(url, { method: 'GET', headers: headers() });
  if (!res.ok) {
    throw new Error('Supabase select failed (' + res.status + '): ' + (await res.text()));
  }
  return res.json();
}

/**
 * Look up every row in `table` (or view — e.g. 'client_pipeline'), unfiltered.
 */
async function selectAll(table, selectClause) {
  assertConfigured();
  const url = SUPABASE_URL + '/rest/v1/' + table + '?select=' + encodeURIComponent(selectClause || '*');
  const res = await fetch(url, { method: 'GET', headers: headers() });
  if (!res.ok) {
    throw new Error('Supabase select failed (' + res.status + '): ' + (await res.text()));
  }
  return res.json();
}

/**
 * Insert a new row into `table`. `Prefer: return=representation` asks
 * PostgREST to hand back the row it just created (with defaults filled in).
 */
async function insertRow(table, row) {
  assertConfigured();
  const url = SUPABASE_URL + '/rest/v1/' + table;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error('Supabase insert failed (' + res.status + '): ' + (await res.text()));
  }
  const rows = await res.json();
  return rows[0];
}

/**
 * Update the row(s) in `table` where `column` equals `value`, merging in the
 * fields in `patch`.
 */
async function updateByColumn(table, column, value, patch) {
  assertConfigured();
  const url =
    SUPABASE_URL + '/rest/v1/' + table + '?' + column + '=eq.' + encodeURIComponent(value);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error('Supabase update failed (' + res.status + '): ' + (await res.text()));
  }
  const rows = await res.json();
  return rows[0] || null;
}

/**
 * Upsert (insert, or update on conflict) a row into `table`, matching
 * PostgREST's `Prefer: resolution=merge-duplicates` upsert behaviour keyed on
 * `onConflictColumn` (a unique/primary-key column). Used for the exactly-one-
 * row-per-order clinical tables (health_profiles, dna_results), where a
 * client or lab result may legitimately be resubmitted/corrected.
 */
async function upsertRow(table, row, onConflictColumn) {
  assertConfigured();
  const url = SUPABASE_URL + '/rest/v1/' + table + '?on_conflict=' + encodeURIComponent(onConflictColumn);
  const res = await fetch(url, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error('Supabase upsert failed (' + res.status + '): ' + (await res.text()));
  }
  const rows = await res.json();
  return rows[0];
}

module.exports = { selectByColumn, selectAll, insertRow, updateByColumn, upsertRow };
