/**
 * GeneThrive — Order Lookup by Client ID
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/lookup-order.js
 *
 * Used by nutripath-portal.html and other partner portals to verify a
 * Client ID (GT-YYYY-NNNN) exists before submitting a status event.
 *
 * USAGE:
 *   GET /.netlify/functions/lookup-order?clientId=GT-2026-0001
 *
 * RETURNS:
 *   200 { order: { clientId, email, name, created_at } }
 *   404 { error: "No order found for client ID: GT-2026-0001" }
 *
 * ENVIRONMENT VARIABLES: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { selectByColumn } = require('./_lib/supabase-rest');

exports.handler = async function handler(event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  const clientId = event.queryStringParameters && event.queryStringParameters.clientId;

  if (!clientId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing clientId parameter' }),
    };
  }

  try {
    const orders = await selectByColumn('orders', 'order_ref', clientId);
    const order  = orders[0];

    if (!order) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: `No order found for client ID: ${clientId}` }),
      };
    }

    // Fetch contact details (name + email) — non-fatal if missing
    let contact = {};
    try {
      const contacts = await selectByColumn('client_contacts', 'id', order.client_contact_id);
      contact = contacts[0] || {};
    } catch (_) {}

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        order: {
          clientId:   order.order_ref,
          name:       [contact.first_name, contact.last_name].filter(Boolean).join(' '),
          email:      contact.email || '',
          created_at: order.paid_at || order.created_at,
        },
      }),
    };
  } catch (err) {
    console.error('GeneThrive lookup-order error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to query database' }),
    };
  }
};