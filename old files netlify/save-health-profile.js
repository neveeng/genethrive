/**
 * GeneThrive — Save Health Profile to Shopify Customer Metafields
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: api/save-health-profile.js
 *
 * FOLDER STRUCTURE ON YOUR PROJECT:
 *   your-project/
 *   ├── netlify.toml          ← tells Netlify where functions live
 *   ├── .env                  ← secret keys (never commit this to Git)
 *   └── netlify/
 *       └── functions/
 *           └── save-health-profile.js   ← this file
 *
 * DEPLOY STEPS:
 *   1. Create a free account at netlify.com
 *   2. Install Netlify CLI:  npm install -g netlify-cli
 *   3. In your project root: netlify init
 *   4. Add environment variables in Netlify dashboard:
 *        Site → Environment variables → Add:
 *        SHOPIFY_STORE_DOMAIN   = your-store.myshopify.com
 *        SHOPIFY_ADMIN_TOKEN    = shpat_xxxxxxxxxxxxxxxxxxxx
 *        ALLOWED_ORIGIN         = https://your-store.myshopify.com
 *   5. Deploy: netlify deploy --prod
 *   6. Your function URL will be:
 *        https://genethrive.netlify.app/.netlify/functions/save-health-profile
 *      (update the URL in page.health-profile.liquid to match)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Map of form field keys → Shopify metafield definitions
// namespace: 'health' groups all fields together on the customer profile
const METAFIELD_DEFINITIONS = [
  { key: 'health_pregnant_breastfeeding', shopifyKey: 'pregnant_breastfeeding', type: 'single_line_text_field' },
  { key: 'health_conditions',             shopifyKey: 'conditions',             type: 'single_line_text_field' },
  { key: 'health_conditions_detail',      shopifyKey: 'conditions_detail',      type: 'multi_line_text_field'  },
  { key: 'health_conditions2',            shopifyKey: 'conditions2',            type: 'single_line_text_field' },
  { key: 'health_medications',            shopifyKey: 'medications',            type: 'single_line_text_field' },
  { key: 'health_medications_detail',     shopifyKey: 'medications_detail',     type: 'multi_line_text_field'  },
  { key: 'health_allergies',              shopifyKey: 'allergies',              type: 'single_line_text_field' },
  { key: 'health_allergies_detail',       shopifyKey: 'allergies_detail',       type: 'multi_line_text_field'  },
  { key: 'health_gender',                 shopifyKey: 'gender',                 type: 'single_line_text_field' },
  { key: 'health_fasting',                shopifyKey: 'fasting',                type: 'single_line_text_field' },
  { key: 'health_fasting_detail',         shopifyKey: 'fasting_detail',         type: 'single_line_text_field' },
  { key: 'health_age',                    shopifyKey: 'age',                    type: 'number_integer'         },
];

export async function handler (event) {
  console.log('Token starts with:', SHOPIFY_ADMIN_TOKEN?.substring(0, 10));
  console.log('Domain:', SHOPIFY_STORE_DOMAIN);
  console.log('Node version:', process.version);
  console.log('fetch available:', typeof fetch);

  // ── 1. CORS — only allow requests from your Shopify store ────────────────
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';

  const corsHeaders = {
    'Access-Control-Allow-Origin':  allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

// Wrap EVERYTHING in try/catch so CORS headers are always returned
try {
  // Handle preflight request
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // ── 2. Parse and validate the request body ───────────────────────────────
  let customerId, healthData;

  try {
    const body    = JSON.parse(event.body);
    customerId    = body.customerId;
    healthData    = body.healthData;
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  if (!customerId || !healthData) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing customerId or healthData' }),
    };
  }

  // Basic safety check — customerId must be a number
  if (!/^\d+$/.test(String(customerId))) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid customerId' }),
    };
  }

  // ── 3. Check environment variables are set ───────────────────────────────
  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    console.error('GeneThrive: Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Server configuration error' }),
    };
  }

  // ── 4. Build metafields array from health data ───────────────────────────
  const metafields = [];

  for (const def of METAFIELD_DEFINITIONS) {
    const value = healthData[def.key];

    // Skip empty values — no point writing blank metafields
    if (value === undefined || value === null || String(value).trim() === '') continue;

    // For integer fields, ensure the value is actually a number
    const finalValue = def.type === 'number_integer'
      ? String(parseInt(value, 10))
      : String(value).trim();

    metafields.push({
      namespace: 'health',
      key:       def.shopifyKey,
      value:     finalValue,
      type:      def.type,
    });
  }

  if (metafields.length === 0) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No valid health data fields to save' }),
    };
  }

  // ── 5. Write metafields to Shopify one by one ────────────────────────────
  // Shopify's REST API accepts one metafield per POST to this endpoint.
  // We fire them in parallel with Promise.allSettled so one failure
  // doesn't block the others.

  const shopifyUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/customers/${customerId}/metafields.json`;

  const saveResults = await Promise.allSettled(
    metafields.map(metafield =>
      fetch(shopifyUrl, {
        method:  'POST',
        headers: {
          'Content-Type':           'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        },
        body: JSON.stringify({ metafield }),
      }).then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(JSON.stringify(data));
        return data;
      })
    )
  );

  // ── 6. Report results ────────────────────────────────────────────────────
  const succeeded = saveResults.filter(r => r.status === 'fulfilled').length;
  const failed    = saveResults.filter(r => r.status === 'rejected');

  if (failed.length > 0) {
    failed.forEach(f => console.error('GeneThrive metafield error:', f.reason));
  }

  // Return success as long as at least one field saved
  if (succeeded > 0) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success:   true,
        saved:     succeeded,
        failed:    failed.length,
        message:   `Saved ${succeeded} of ${metafields.length} health metafields for customer ${customerId}`,
      }),
    };
  }

  // All failed
  return {
    statusCode: 500,
    headers: corsHeaders,
    body: JSON.stringify({
      success: false,
      error:   'Failed to save any metafields. Check Netlify logs for details.',
    }),
  };
  } catch (err) {
    // Catch-all — always return CORS headers even on unexpected crash
    console.error('Unhandled error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Unexpected server error', detail: err.message }),
    };
  }
}