/**
 * GeneThrive — Admin Trigger (Secure Proxy)
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/admin-trigger.js
 *
 * WHY THIS EXISTS:
 *   The admin HTML page can't safely hold LAB_WEBHOOK_SECRET — anything in
 *   browser JS is publicly visible. This function acts as a secure middleman:
 *   the admin page calls THIS function (no secret needed from the browser),
 *   and THIS function adds the secret before forwarding to dispatch-results.js.
 *
 * FLOW:
 *   admin-dispatch.html
 *     → POST /admin-trigger (with OPS_TOKEN for auth)
 *       → POST /dispatch-results (adds LAB_WEBHOOK_SECRET server-side)
 *
 * ENVIRONMENT VARIABLES (add to Netlify + .env):
 *   OPS_ADMIN_TOKEN    = a separate strong secret for the admin page
 *                        (different from LAB_WEBHOOK_SECRET)
 *   LAB_WEBHOOK_SECRET = existing secret — now only used server-side
 *
 * GENERATE OPS_ADMIN_TOKEN (run in terminal):
 *   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
 * ─────────────────────────────────────────────────────────────────────────────
 */

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Ops-Token',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  // 1. Verify the ops admin token (from the browser — not the lab secret)
  const opsToken = event.headers['x-ops-token'];
  if (!opsToken || opsToken !== process.env.OPS_ADMIN_TOKEN) {
    console.warn('GeneThrive admin-trigger: invalid or missing ops token');
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // 2. Parse and validate the request body
  let clientId, results, reportUrl;
  try {
    const body = JSON.parse(event.body);
    clientId  = body.clientId;
    results   = body.results;
    reportUrl = body.reportUrl;
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!clientId || !results) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing clientId or results' }),
    };
  }

  // 3. Forward to dispatch-results with the lab secret added server-side
  const dispatchUrl = `${process.env.URL_NETLIFY}/.netlify/functions/dispatch-results`;

  try {
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Content-Type':        'application/json',
        'X-GeneThrive-Secret': process.env.LAB_WEBHOOK_SECRET, // never exposed to browser
      },
      body: JSON.stringify({ clientId, results, reportUrl }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('GeneThrive admin-trigger: dispatch-results returned', res.status, data);
      return {
        statusCode: res.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: data.error || 'Dispatch failed' }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(data),
    };

  } catch (err) {
    console.error('GeneThrive admin-trigger: fetch error —', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal error — check Netlify logs' }),
    };
  }
};
