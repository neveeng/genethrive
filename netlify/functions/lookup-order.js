/**
 * GeneThrive — Order Lookup by Client ID
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/lookup-order.js
 *
 * Used by the admin dispatch page to verify a Client ID exists
 * before the ops team triggers a results dispatch.
 *
 * USAGE:
 *   GET /.netlify/functions/lookup-order?clientId=GT-1042-a3f9c2
 *
 * RETURNS:
 *   { order: { order_number, email, created_at, tags } }
 *
 * ENVIRONMENT VARIABLES (same as other functions):
 *   SHOPIFY_STORE_DOMAIN
 *   SHOPIFY_ADMIN_TOKEN
 * ─────────────────────────────────────────────────────────────────────────────
 */

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  const clientId = event.queryStringParameters?.clientId;

  if (!clientId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing clientId parameter' }),
    };
  }

  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

  try {
    const res = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json` +
      `?tag=client-id:${encodeURIComponent(clientId)}&status=any&limit=1`,
      {
        headers: {
          'Content-Type':           'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        },
      }
    );

    const data  = await res.json();
    const order = data.orders?.[0];

    if (!order) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: `No order found for client ID: ${clientId}` }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        order: {
          order_number: order.order_number,
          email:        order.email,
          created_at:   order.created_at,
          tags:         order.tags,
        },
      }),
    };

  } catch (err) {
    console.error('GeneThrive lookup-order error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to query Shopify' }),
    };
  }
};
