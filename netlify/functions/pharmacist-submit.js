/**
 * GeneThrive — Pharmacist Submit
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/pharmacist-submit.js
 *
 * CALLED BY: pharmacist-portal.html
 *
 * WHAT IT DOES:
 *   1. Verifies Pharmacist's session token
 *   2. Looks up Shopify order by Client ID
 *   3. Releases pharmacist payment ($140) via Stripe
 *   4. Notifies client that vitamins have been dispatched
 *   5. Notifies ops
 *   6. Tags Shopify order: vitamins-dispatched, pharmacist-paid
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto     = require('crypto');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const { shopifyFetch } = require('./shopify-token');

function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts   = decoded.split(':');
    if (parts.length !== 3) return null;
    const [partner, expires, sig] = parts;
    if (Date.now() > parseInt(expires)) return null;
    const expected = crypto
      .createHmac('sha256', process.env.PARTNER_TOKEN_SECRET || 'fallback')
      .update(`${partner}:${expires}`)
      .digest('hex');
    if (sig !== expected) return null;
    return partner;
  } catch { return null; }
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Partner-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // 1. Verify pharmacist token
  const token   = event.headers['x-partner-token'];
  const partner = verifyToken(token);
  if (partner !== 'pharmacist') {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // 2. Parse request
  let clientId, trackingNumber, notes;
  try {
    const body    = JSON.parse(event.body);
    clientId      = body.clientId?.trim();
    trackingNumber = body.trackingNumber?.trim() || null;
    notes         = body.notes || '';
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!clientId) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing clientId' }) };
  }

  // 3. Look up Shopify order
  let order;
  try {
    const res  = await shopifyFetch(
      `/admin/api/2024-01/orders.json?tag=client-id:${encodeURIComponent(clientId)}&status=any&limit=1`
    );
    const data = await res.json();
    order      = data.orders?.[0];
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not look up order' }) };
  }

  if (!order) {
    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: `No order found for ${clientId}` }) };
  }

  // Check CIL was completed first
  if (!order.tags?.includes('cil-completed')) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'CIL consultation has not been completed yet. Please wait for the naturopath to submit their notes.' }),
    };
  }

  // Idempotency check
  if (order.tags?.includes('vitamins-dispatched')) {
    return {
      statusCode: 409,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Vitamins already marked as dispatched for this Client ID.' }),
    };
  }

  const orderDate   = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });
  const firstName   = order.shipping_address?.first_name || 'there';

  // 4. Release pharmacist payment ($140)
  if (process.env.STRIPE_ACCOUNT_PHARMACIST && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
      const transfer = await stripe.transfers.create({
        amount:      parseInt(process.env.PRICE_PHARMACIST_CENTS || "14000"),
        currency:    'aud',
        destination: process.env.STRIPE_ACCOUNT_PHARMACIST,
        description: `GeneThrive ${clientId} — compounding and dispatch fee`,
        metadata:    { clientId, stage: 'vitamins-dispatched' },
      });
      console.log(`GeneThrive: Pharmacist $140 transferred — ${transfer.id}`);
    } catch (err) {
      console.error('GeneThrive: Pharmacist transfer failed —', err.message);
    }
  }

  // 5. Send emails
  const transporter = createTransporter();

  try {
    await Promise.all([

      // Client dispatch notification
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      order.email,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Your GeneThrive vitamins are on their way — ${clientId}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
              <h2 style="margin:0 0 14px;font-size:18px;font-weight:500">Your vitamins are on their way, ${firstName}!</h2>
              <p style="margin:0 0 16px;font-size:14px;color:#4a4a46;line-height:1.6">
                Your personalised vitamin formula has been compounded and dispatched by our pharmacist.
              </p>
              <div style="background:#e8eee7;border-radius:8px;padding:18px;margin-bottom:20px">
                <table style="width:100%;font-size:13px;border-collapse:collapse">
                  <tr style="border-bottom:1px solid #c5d9c0">
                    <td style="padding:8px 0;color:#4a6741;font-weight:500">Reference</td>
                    <td style="padding:8px 0;font-weight:700">${clientId}</td>
                  </tr>
                  <tr style="border-bottom:1px solid #c5d9c0">
                    <td style="padding:8px 0;color:#4a6741;font-weight:500">Dispatched</td>
                    <td style="padding:8px 0">${orderDate}</td>
                  </tr>
                  ${trackingNumber ? `<tr>
                    <td style="padding:8px 0;color:#4a6741;font-weight:500">Tracking</td>
                    <td style="padding:8px 0;font-weight:600">${trackingNumber}</td>
                  </tr>` : ''}
                </table>
              </div>
              ${notes ? `<p style="font-size:13px;color:#4a4a46;margin:0 0 16px;line-height:1.6"><strong>Note from your pharmacist:</strong> ${notes}</p>` : ''}
              <p style="font-size:14px;color:#4a4a46;line-height:1.6;margin:0 0 16px">
                Please allow 3–5 business days for delivery. Your next monthly supply will be
                automatically dispatched and charged at <strong>$200.00/month</strong>.
              </p>
              <p style="font-size:13px;color:#7a7a74;margin:0">
                Questions? <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
              </p>
            </div>
          </div>
        `,
      }),

      // Ops notification
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_OPS,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Vitamins Dispatched — ${clientId} — $140 released to pharmacist`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;color:#1c1c1a">
            <div style="background:#1c1c1a;padding:16px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:15px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <table style="width:100%;font-size:13px;border-collapse:collapse">
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74;width:160px">Client ID</td>
                  <td style="padding:8px 0;font-weight:600">${clientId}</td>
                </tr>
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">Dispatched</td>
                  <td style="padding:8px 0">${orderDate}</td>
                </tr>
                ${trackingNumber ? `<tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">Tracking</td>
                  <td style="padding:8px 0;font-weight:600">${trackingNumber}</td>
                </tr>` : ''}
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">Pharmacist payment</td>
                  <td style="padding:8px 0;color:#166534;font-weight:500">$140.00 released</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#7a7a74">Status</td>
                  <td style="padding:8px 0;color:#4a6741;font-weight:500">Order complete</td>
                </tr>
              </table>
            </div>
          </div>
        `,
      }),

    ]);
    console.log(`GeneThrive: Pharmacist submit emails sent for ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: Email sending failed —', err.message);
  }

  // 6. Tag Shopify order
  try {
    const existingTags = order.tags ? order.tags.split(', ') : [];
    existingTags.push('vitamins-dispatched', 'pharmacist-paid');
    await shopifyFetch(`/admin/api/2024-01/orders/${order.id}.json`, {
      method: 'PUT',
      body:   JSON.stringify({ order: { id: order.id, tags: existingTags.join(', ') } }),
    });
  } catch (err) {
    console.warn('GeneThrive: Order tagging failed —', err.message);
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success:  true,
      clientId,
      message:  'Vitamins marked as dispatched. Client notified. $140.00 released.',
    }),
  };
};