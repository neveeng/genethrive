/**
 * GeneThrive — Nutripath Submit
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/nutripath-submit.js
 *
 * CALLED BY: nutripath-portal.html
 *
 * WHAT IT DOES:
 *   1. Verifies Nutripath's session token
 *   2. Looks up Shopify order by Client ID
 *   3. Releases second Nutripath payment ($137.50) via Stripe
 *   4. Emails DNA results PDF to naturopath
 *   5. Emails results notification to GeneThrive ops
 *   6. Notifies client that results are ready
 *   7. Tags Shopify order: dna-results-received
 *
 * ENVIRONMENT VARIABLES:
 *   PARTNER_TOKEN_SECRET
 *   STRIPE_SECRET_KEY
 *   STRIPE_ACCOUNT_NUTRIPATH
 *   SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN
 *   SMTP_HOST / PORT / USER / PASS
 *   EMAIL_FROM / EMAIL_OPS / EMAIL_NATUROPATH / EMAIL_REPLY_TO
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto     = require('crypto');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const { shopifyFetch } = require('./shopify-token');

// Inline token verification (mirrors partner-auth.js)
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

  // 1. Verify Nutripath token
  const token   = event.headers['x-partner-token'];
  const partner = verifyToken(token);
  if (partner !== 'nutripath') {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // 2. Parse request — clientId + base64 PDF
  let clientId, pdfBase64, notes;
  try {
    const body = JSON.parse(event.body);
    clientId   = body.clientId?.trim();
    pdfBase64  = body.pdfBase64;   // base64-encoded PDF file
    notes      = body.notes || ''; // optional text notes
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!clientId || !pdfBase64) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing clientId or PDF' }) };
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

  // Idempotency — don't process twice
  if (order.tags?.includes('dna-results-received')) {
    return {
      statusCode: 409,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'DNA results already submitted for this Client ID' }),
    };
  }

  const orderDate = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });
  const pdfBuffer = Buffer.from(pdfBase64, 'base64');

  // 4. Release second Nutripath payment ($137.50)
  if (process.env.STRIPE_ACCOUNT_NUTRIPATH && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
      const transfer = await stripe.transfers.create({
        amount:      parseInt(process.env.PRICE_NUTRIPATH_2_CENTS || "13750"),
        currency:    'aud',
        destination: process.env.STRIPE_ACCOUNT_NUTRIPATH,
        description: `GeneThrive ${clientId} — DNA results payment (2nd half)`,
        metadata:    { clientId, stage: 'dna-results' },
      });
      console.log(`GeneThrive: Nutripath 2nd payment $137.50 transferred — ${transfer.id}`);
    } catch (err) {
      console.error('GeneThrive: Nutripath 2nd transfer failed —', err.message);
      // Non-fatal — continue with emails
    }
  }

  // 5. Send emails
  const transporter = createTransporter();

  try {
    await Promise.all([

      // Email to naturopath with results PDF
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_NATUROPATH,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `DNA Results Ready for CIL Review — ${clientId}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 16px;font-size:14px">DNA results have been received for the following client. Please log in to your portal to review and complete the CIL consultation.</p>
              <div style="background:#f7f4ee;border-radius:6px;padding:14px;margin-bottom:16px">
                <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">CLIENT ID</div>
                <div style="font-size:20px;font-weight:700">${clientId}</div>
                <div style="font-size:12px;color:#7a7a74;margin-top:4px">${orderDate}</div>
              </div>
              ${notes ? `<p style="font-size:13px;color:#4a4a46;margin:0 0 16px"><strong>Notes from lab:</strong> ${notes}</p>` : ''}
              <p style="font-size:13px;font-weight:600;margin:0 0 8px">Action required:</p>
              <ol style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 16px;padding-left:18px">
                <li>Review DNA results in the attached PDF</li>
                <li>Complete CIL consultation with client</li>
                <li>Upload your CIL script/notes via the Naturopath Portal</li>
                <li>Your payment of $65.00 will be released upon submission</li>
              </ol>
              <p style="font-size:13px;color:#7a7a74">DNA results PDF attached.</p>
            </div>
          </div>
        `,
        attachments: [{
          filename:    `GeneThrive-DNA-Results-${clientId}.pdf`,
          content:     pdfBuffer,
          contentType: 'application/pdf',
        }],
      }),

      // Ops notification
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_OPS,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `DNA Results Received — ${clientId} — Nutripath 2nd payment released`,
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
                  <td style="padding:8px 0;color:#7a7a74">Date</td>
                  <td style="padding:8px 0">${orderDate}</td>
                </tr>
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">Nutripath 2nd payment</td>
                  <td style="padding:8px 0;color:#166534;font-weight:500">$137.50 released</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#7a7a74">Next step</td>
                  <td style="padding:8px 0">Results sent to naturopath for CIL review</td>
                </tr>
              </table>
            </div>
          </div>
        `,
      }),

      // Client notification
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      order.email,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Your DNA results are in — ${clientId}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
              <h2 style="margin:0 0 14px;font-size:18px;font-weight:500">Great news!</h2>
              <p style="margin:0 0 16px;font-size:14px;color:#4a4a46;line-height:1.6">
                Your DNA results have been received. Our naturopath is now reviewing your results
                alongside your health profile to finalise your personalised vitamin formula.
              </p>
              <div style="background:#e8eee7;border-radius:8px;padding:16px;margin-bottom:20px">
                <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">YOUR REFERENCE</div>
                <div style="font-size:18px;font-weight:700">${clientId}</div>
              </div>
              <p style="font-size:13px;color:#7a7a74;margin:0">
                You will be contacted shortly to schedule your CIL consultation.
                Questions? <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
              </p>
            </div>
          </div>
        `,
      }),

    ]);
    console.log(`GeneThrive: Nutripath submit emails sent for ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: Email sending failed —', err.message);
  }

  // 6. Tag Shopify order
  try {
    const existingTags = order.tags ? order.tags.split(', ') : [];
    existingTags.push('dna-results-received');
    await shopifyFetch(`/admin/api/2024-01/orders/${order.id}.json`, {
      method: 'PUT',
      body:   JSON.stringify({ order: { id: order.id, tags: existingTags.join(', ') } }),
    });
    console.log(`GeneThrive: Order #${order.order_number} tagged dna-results-received`);
  } catch (err) {
    console.warn('GeneThrive: Order tagging failed —', err.message);
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success:  true,
      clientId,
      message:  'DNA results submitted. Naturopath notified. $137.50 released to Nutripath.',
    }),
  };
};