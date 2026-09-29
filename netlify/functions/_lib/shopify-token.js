/**
 * GeneThrive — Shopify Token Helper
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches a short-lived Shopify Admin API access token using client credentials.
 * Used by finalise-order.js and lookup-order.js instead of a static shpat_ token.
 *
 * ENVIRONMENT VARIABLES:
 *   SHOPIFY_SHOP          = genethrive  (just the subdomain, no .myshopify.com)
 *   SHOPIFY_CLIENT_ID     = your Partners app Client ID
 *   SHOPIFY_CLIENT_SECRET = your Partners app Client Secret (the New one)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { URLSearchParams } = require('url');

// Simple in-memory cache — token is reused within the same function invocation
let _token = null;
let _tokenExpiresAt = 0;

async function getShopifyToken() {
  // Return cached token if still valid (with 60s buffer)
  if (_token && Date.now() < _tokenExpiresAt - 60_000) {
    return _token;
  }

  const shop         = process.env.SHOPIFY_SHOP;
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error('Missing SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET env vars');
  }

  const response = await fetch(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     clientId,
        client_secret: clientSecret,
      }),
    }
  );

  const rawText = await response.text();

  if (!response.ok) {
    console.error(`GeneThrive: Shopify token failed — status ${response.status}`);
    console.error(`GeneThrive: Shopify token response — ${rawText}`);
    console.error(`GeneThrive: SHOPIFY_SHOP = ${shop}`);
    console.error(`GeneThrive: SHOPIFY_CLIENT_ID = ${clientId}`);
    console.error(`GeneThrive: SHOPIFY_CLIENT_SECRET set = ${!!clientSecret}`);
    throw new Error(`Shopify token request failed: ${response.status} — ${rawText}`);
  }

  let tokenJson;
  try {
    tokenJson = JSON.parse(rawText);
  } catch {
    console.error('GeneThrive: Shopify token response not valid JSON —', rawText.slice(0, 200));
    throw new Error('Shopify token response was not valid JSON');
  }

  const { access_token, expires_in } = tokenJson;

  if (!access_token) {
    console.error('GeneThrive: Token response missing access_token —', JSON.stringify(tokenJson));
    throw new Error('Shopify token response missing access_token');
  }
  _token          = access_token;
  _tokenExpiresAt = Date.now() + expires_in * 1000;

  console.log('GeneThrive: Shopify access token fetched successfully');
  return _token;
}

/**
 * Make an authenticated REST API call to Shopify.
 * @param {string} path  - e.g. '/admin/api/2024-01/orders.json'
 * @param {object} opts  - fetch options (method, body etc.)
 */
async function shopifyFetch(path, opts = {}) {
  const shop  = process.env.SHOPIFY_SHOP;
  const token = await getShopifyToken();

  const url = `https://${shop}.myshopify.com${path}`;

  const response = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': token,
      ...(opts.headers || {}),
    },
  });

  return response;
}

module.exports = { getShopifyToken, shopifyFetch };