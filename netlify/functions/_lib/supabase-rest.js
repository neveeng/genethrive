/**
 * GeneThrive — shared PostgREST REST client
 * =============================================================================
 * Thin wrapper around Supabase's PostgREST HTTP API, used by every Netlify
 * function in this project that reads from or writes to Supabase. All calls
 * use the service_role key (bypasses RLS — appropriate for server-side only,
 * never exposed to a browser).
 *
 * Exports:
 *   selectByColumn(table, column, value)   — returns array of matching rows
 *   insertRow(table, data)                 — inserts one row, returns it
 *   upsertRow(table, data, onConflict)     — upserts one row, returns it
 *   updateRows(table, matchCol, matchVal, data) — updates matching rows
 *
 * ENVIRONMENT VARIABLES NEEDED:
 *   SUPABASE_URL            — e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY — the service_role (not anon) key
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function baseHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

/**
 * Select rows from a table where column = value (exact match).
 * Returns an array (may be empty).
 */
async function selectByColumn(table, column, value) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('supabase-rest: SUPABASE_URL or SUPABASE_SERVICE_KEY env var is missing');
  }
  const url = `${SUPABASE_URL}/rest/v1/${table}?${column}=eq.${encodeURIComponent(value)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...baseHeaders(), 'Prefer': 'return=representation' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase-rest selectByColumn(${table}, ${column}): ${res.status} ${body}`);
  }
  return res.json();
}

/**
 * Insert a single row into a table. Returns the inserted row.
 */
async function insertRow(table, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('supabase-rest: SUPABASE_URL or SUPABASE_SERVICE_KEY env var is missing');
  }
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase-rest insertRow(${table}): ${res.status} ${body}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

/**
 * Upsert a single row into a table, resolving conflicts on the given column.
 * Returns the upserted row.
 */
async function upsertRow(table, data, onConflict) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('supabase-rest: SUPABASE_URL or SUPABASE_SERVICE_KEY env var is missing');
  }
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...baseHeaders(),
      'Prefer': `return=representation,resolution=merge-duplicates`,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase-rest upsertRow(${table}): ${res.status} ${body}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

/**
 * Update rows in a table where matchCol = matchVal.
 * Returns array of updated rows.
 */
async function updateRows(table, matchCol, matchVal, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('supabase-rest: SUPABASE_URL or SUPABASE_SERVICE_KEY env var is missing');
  }
  const url = `${SUPABASE_URL}/rest/v1/${table}?${matchCol}=eq.${encodeURIComponent(matchVal)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: baseHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase-rest updateRows(${table}, ${matchCol}): ${res.status} ${body}`);
  }
  return res.json();
}

module.exports = { selectByColumn, insertRow, upsertRow, updateRows };
