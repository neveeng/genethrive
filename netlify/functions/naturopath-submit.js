/**
 * GeneThrive — Naturopath Submit
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/naturopath-submit.js
 *
 * CALLED BY: naturopath-portal.html
 *
 * WHAT IT DOES:
 *   1. Verifies Naturopath's session token
 *   2. Looks up Shopify order by Client ID
 *   3. Releases Naturopath payment ($65) via Stripe
 *   4. Emails CIL script PDF + formula brief to pharmacist
 *   5. Notifies ops
 *   6. Tags Shopify order: cil-completed
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

  // 1. Verify naturopath token
  const token   = event.headers['x-partner-token'];
  const partner = verifyToken(token);
  if (partner !== 'naturopath') {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // 2. Parse request
  let clientId, pdfBase64, notes;
  try {
    const body = JSON.parse(event.body);
    clientId   = body.clientId?.trim();
    pdfBase64  = body.pdfBase64;
    notes      = body.notes || '';
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

  // Check DNA results were received first
  if (!order.tags?.includes('dna-results-received')) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'DNA results have not been submitted yet for this Client ID. Please wait for Nutripath to submit results first.' }),
    };
  }

  // Idempotency check
  if (order.tags?.includes('cil-completed')) {
    return {
      statusCode: 409,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'CIL consultation already completed for this Client ID.' }),
    };
  }

  const orderDate = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });
  const pdfBuffer = Buffer.from(pdfBase64, 'base64');

  // 4. Release naturopath payment ($65)
  if (process.env.STRIPE_ACCOUNT_NATUROPATH && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
      const transfer = await stripe.transfers.create({
        amount:      6500,
        currency:    'aud',
        destination: process.env.STRIPE_ACCOUNT_NATUROPATH,
        description: `GeneThrive ${clientId} — CIL consultation fee`,
        metadata:    { clientId, stage: 'cil-completed' },
      });
      console.log(`GeneThrive: Naturopath $65 transferred — ${transfer.id}`);
    } catch (err) {
      console.error('GeneThrive: Naturopath transfer failed —', err.message);
    }
  }

  // 5. Extract health data from order for pharmacist context
  const healthData = {};
  for (const attr of (order.note_attributes || [])) {
    if (attr.name.startsWith('health_')) {
      healthData[attr.name.replace('health_', '')] = attr.value;
    }
  }

  // 6. Send emails
  const transporter = createTransporter();

  try {
    await Promise.all([

      // Email pharmacist with CIL script + formula brief
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_PHARMACIST,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Formula Ready for Compounding — ${clientId}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 16px;font-size:14px">The naturopath has completed the CIL consultation. Please log in to your portal to review the formula brief and compound the vitamins.</p>
              <div style="background:#f7f4ee;border-radius:6px;padding:14px;margin-bottom:16px">
                <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">CLIENT ID</div>
                <div style="font-size:20px;font-weight:700">${clientId}</div>
              </div>
              ${notes ? `<div style="background:#fff7ed;border-radius:6px;padding:14px;margin-bottom:16px">
                <div style="font-size:10px;color:#92400e;font-weight:600;letter-spacing:1px;margin-bottom:6px">NATUROPATH NOTES</div>
                <div style="font-size:13px;color:#1c1c1a;line-height:1.6">${notes}</div>
              </div>` : ''}
              <div style="background:#f0f7f0;border-radius:6px;padding:14px;margin-bottom:16px">
                <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:8px">CLIENT HEALTH PROFILE</div>
                <table style="width:100%;font-size:12px;color:#4a4a46;border-collapse:collapse">
                  ${Object.entries({
                    'Allergies':   healthData.health_allergies === 'Yes' ? healthData.health_allergies_detail : 'None',
                    'Medications': healthData.health_medications === 'Yes' ? healthData.health_medications_detail : 'None',
                    'Conditions':  healthData.health_conditions === 'Yes' ? healthData.health_conditions_detail : 'None',
                    'Gender':      healthData.health_gender,
                    'Age':         healthData.health_age ? `${healthData.health_age} years` : '—',
                  }).map(([k, v]) => `<tr><td style="padding:4px 8px 4px 0;color:#7a7a74;width:100px">${k}</td><td style="padding:4px 0">${v || '—'}</td></tr>`).join('')}
                </table>
              </div>
              <p style="font-size:13px;font-weight:600;margin:0 0 8px">Action required:</p>
              <ol style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 16px;padding-left:18px">
                <li>Review the CIL script in the attached PDF</li>
                <li>Compound the personalised vitamin formula</li>
                <li>Dispatch vitamins to client via your portal</li>
                <li>Your payment of $140.00 will be released on dispatch confirmation</li>
              </ol>
              <p style="font-size:13px;color:#7a7a74">CIL script attached.</p>
            </div>
          </div>
        `,
        attachments: [{
          filename:    `GeneThrive-CIL-Script-${clientId}.pdf`,
          content:     pdfBuffer,
          contentType: 'application/pdf',
        }],
      }),

      // Ops notification
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_OPS,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `CIL Completed — ${clientId} — $65 released to naturopath`,
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
                  <td style="padding:8px 0;color:#7a7a74">Naturopath payment</td>
                  <td style="padding:8px 0;color:#166534;font-weight:500">$65.00 released</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#7a7a74">Next step</td>
                  <td style="padding:8px 0">Pharmacist notified to compound and dispatch</td>
                </tr>
              </table>
            </div>
          </div>
        `,
      }),

    ]);
    console.log(`GeneThrive: Naturopath submit emails sent for ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: Email sending failed —', err.message);
  }

  // 7. Tag Shopify order
  try {
    const existingTags = order.tags ? order.tags.split(', ') : [];
    existingTags.push('cil-completed');
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
      message:  'CIL script submitted. Pharmacist notified. $65.00 released.',
    }),
  };
};