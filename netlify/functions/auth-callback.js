/**
 * GeneThrive — Shopify OAuth Callback
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/auth-callback.js
 *
 * This is a ONE-TIME function used to get a permanent offline access token
 * from Shopify. Once you have the token, save it as SHOPIFY_ADMIN_TOKEN
 * in Netlify env vars and you never need to run this again.
 *
 * USAGE:
 *   1. Visit the authorize URL in your browser (Step 3 below)
 *   2. Shopify redirects here with a ?code= parameter
 *   3. This function exchanges the code for a permanent token
 *   4. Copy the token from the page and save it to Netlify env vars
 *
 * ENVIRONMENT VARIABLES:
 *   SHOPIFY_STORE_DOMAIN  = genethrive.myshopify.com
 *   SHOPIFY_CLIENT_ID     = 5481b1429dd4cafe51f8a7c89defbf4c
 *   SHOPIFY_CLIENT_SECRET = your-client-secret
 * ─────────────────────────────────────────────────────────────────────────────
 */

exports.handler = async function (event) {

  const { code, shop, error } = event.queryStringParameters || {};

  if (error) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: `<h2>OAuth Error</h2><p>${error}</p>`,
    };
  }

  if (!code || !shop) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: `<h2>Missing parameters</h2><p>code: ${code}, shop: ${shop}</p>`,
    };
  }

  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html' },
      body: '<h2>Missing env vars</h2><p>SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET not set in Netlify</p>',
    };
  }

  try {
    // Exchange the code for a permanent offline access token
    const response = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     clientId,
          client_secret: clientSecret,
          code,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'text/html' },
        body: `<h2>Token exchange failed</h2><pre>${JSON.stringify(data, null, 2)}</pre>`,
      };
    }

    // Success — show the token so you can copy it
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <!DOCTYPE html>
        <html>
        <head>
          <title>GeneThrive — Token Retrieved</title>
          <style>
            body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 20px; }
            h1 { color: #4A6741; }
            .token-box {
              background: #E8EEE7;
              border: 2px solid #4A6741;
              border-radius: 8px;
              padding: 20px;
              margin: 20px 0;
              word-break: break-all;
              font-family: monospace;
              font-size: 14px;
            }
            .steps { background: #f7f4ee; border-radius: 8px; padding: 20px; }
            .steps ol { margin: 10px 0 0 20px; line-height: 2; }
            .warning { color: #B91C1C; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>GeneThrive — Shopify Token Retrieved</h1>
          <p class="warning">Copy this token NOW — this page will not show it again.</p>
          <div class="token-box">${data.access_token}</div>
          <div class="steps">
            <strong>Next steps:</strong>
            <ol>
              <li>Copy the token above</li>
              <li>Go to Netlify dashboard → Site configuration → Environment variables</li>
              <li>Add variable: <strong>SHOPIFY_ADMIN_TOKEN</strong> = the token above</li>
              <li>Also add: <strong>SHOPIFY_STORE_DOMAIN</strong> = genethrive.myshopify.com</li>
              <li>Click Save → redeploy: <code>netlify deploy --prod</code></li>
              <li>You can now delete this auth-callback function — it's no longer needed</li>
            </ol>
          </div>
          <p style="margin-top:20px;color:#7a7a74;font-size:13px">
            Scopes granted: ${data.scope}
          </p>
        </body>
        </html>
      `,
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html' },
      body: `<h2>Error</h2><p>${err.message}</p>`,
    };
  }
};