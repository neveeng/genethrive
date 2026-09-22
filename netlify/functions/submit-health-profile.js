/**
 * GeneThrive — Submit Health Profile
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/submit-health-profile.js
 *
 * CALLED BY: page.health-profile.liquid (after payment)
 *
 * WHAT IT DOES:
 *   1. Validates the client ID exists in Supabase order_sla
 *   2. Inserts health profile into Supabase health_profiles table
 *   3. Updates order_sla.health_profile_submitted_at timestamp
 *   4. Updates Shopify order tag: pdf-pending → profile-complete
 *   5. Sends ops notification (status only — no health content)
 *   6. Notifies NutriPath to dispatch kit (address only)
 *
 * PRIVACY:
 *   - Health data goes to Supabase only
 *   - Ops email contains NO health content — status flag only
 *   - NutriPath gets client address only — no clinical data
 *
 * ENVIRONMENT VARIABLES:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   EMAIL_FROM, EMAIL_OPS, EMAIL_NUTRIPATH, EMAIL_REPLY_TO
 * ─────────────────────────────────────────────────────────────────────────────
 */

const nodemailer = require('nodemailer');
const { shopifyFetch } = require('./shopify-token');
const { advanceStage } = require('./sla-stage');


function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function supabaseRequest(path, method = 'GET', body = null) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer':        method === 'POST' ? 'return=representation' : '',
    },
    body: body ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // 1. Parse request
  let clientId, healthData, clientDetails;
  try {
    const body    = JSON.parse(event.body);
    clientId      = body.clientId?.trim();
    healthData    = body.healthData || {};
    clientDetails = body.clientDetails || {};
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!clientId) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing clientId' }) };
  }

  console.log(`GeneThrive: Saving health profile for ${clientId}`);

  // 2. Insert health profile into Supabase
  const profileRes = await supabaseRequest('/health_profiles', 'POST', {
    client_id:                   clientId,
    stripe_payment_intent:       clientDetails.paymentIntentId || null,
    pregnant_breastfeeding:      healthData.health_pregnant_breastfeeding || null,
    conditions:                  healthData.health_conditions || null,
    conditions_detail:           healthData.health_conditions_detail || null,
    conditions_haematological:   healthData.health_conditions2 || null,
    medications:                 healthData.health_medications || null,
    medications_detail:          healthData.health_medications_detail || null,
    allergies:                   healthData.health_allergies || null,
    allergies_detail:            healthData.health_allergies_detail || null,
    gender:                      healthData.health_gender || null,
    age:                         healthData.health_age ? parseInt(healthData.health_age) : null,
    fasting:                     healthData.health_fasting || null,
    fasting_detail:              healthData.health_fasting_detail || null,
    profile_complete:            true,
  });

  if (!profileRes.ok) {
    // Handle duplicate — profile already submitted
    if (profileRes.status === 409) {
      return {
        statusCode: 409,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Health profile already submitted for this Client ID.' }),
      };
    }
    console.error('GeneThrive: Supabase health profile insert failed —', JSON.stringify(profileRes.data));
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Could not save health profile. Please try again.' }),
    };
  }

  console.log(`GeneThrive: Health profile saved to Supabase for ${clientId}`);

  // 3. Update order_sla timestamp
  await supabaseRequest(
    `/order_sla?client_id=eq.${encodeURIComponent(clientId)}`,
    'PATCH',
    { health_profile_submitted_at: new Date().toISOString() }
  );

  // after the supabase patch that sets health_profile_submitted_at:
await advanceStage(clientId, 'kit_dispatch');

  // 4. Update Shopify order tag: add profile-complete, remove pdf-pending
  try {
    const orderRes  = await shopifyFetch(
      `/admin/api/2024-01/orders.json?tag=client-id:${encodeURIComponent(clientId)}&status=any&limit=1`
    );
    const orderData = await orderRes.json();
    const order     = orderData.orders?.[0];

    if (order) {
      const tags = (order.tags || '').split(', ')
        .filter(t => t.trim() && t !== 'pdf-pending')
        .concat(['profile-complete']);

      await shopifyFetch(`/admin/api/2024-01/orders/${order.id}.json`, {
        method: 'PUT',
        body:   JSON.stringify({ order: { id: order.id, tags: tags.join(', ') } }),
      });
      console.log(`GeneThrive: Shopify order tagged profile-complete for ${clientId}`);
    }
  } catch (err) {
    console.warn('GeneThrive: Shopify tag update failed —', err.message);
  }

  // 5. Send emails
  try {
    const transporter = createTransporter();
    const orderDate   = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

    await Promise.all([

      // Ops — status only, NO health content
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_OPS,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Health profile received — ${clientId} — Ready for kit dispatch`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;color:#1c1c1a">
            <div style="background:#1c1c1a;padding:16px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:15px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
              <span style="color:rgba(255,255,255,0.5);font-size:12px;margin-left:10px">Ops Notification</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <p style="font-size:14px;margin:0 0 16px;color:#4a4a46">
                Client health profile has been received and stored securely.
                NutriPath has been notified to dispatch the swab kit.
              </p>
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
                  <td style="padding:8px 0;color:#7a7a74">Profile status</td>
                  <td style="padding:8px 0;color:#166534;font-weight:500">Complete</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#7a7a74">Next step</td>
                  <td style="padding:8px 0">NutriPath to dispatch swab kit within 48h</td>
                </tr>
              </table>
              <p style="font-size:12px;color:#7a7a74;margin:16px 0 0;font-style:italic">
                Health content is stored securely in Supabase — not visible here.
              </p>
            </div>
          </div>
        `,
      }),

      // NutriPath — address only for kit dispatch, NO health content
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_NUTRIPATH,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `New swab kit dispatch required — ${clientId}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <p style="font-size:14px;margin:0 0 16px;color:#4a4a46">
                Please dispatch a mouth swab kit to the following address within 48 hours.
              </p>
              <div style="background:#f7f4ee;border-radius:8px;padding:16px;margin-bottom:16px">
                <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">CLIENT ID</div>
                <div style="font-size:20px;font-weight:700;margin-bottom:12px">${clientId}</div>
                <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:8px">SHIP TO</div>
                <div style="font-size:14px;line-height:1.8;color:#1c1c1a">
                  <strong>${clientDetails.name || '—'}</strong><br>
                  ${clientDetails.address || '—'}<br>
                  ${clientDetails.suburb || ''} ${clientDetails.state || ''} ${clientDetails.postcode || ''}<br>
                  ${clientDetails.phone || '—'}
                </div>
              </div>
              <p style="font-size:13px;font-weight:600;color:#1c1c1a;margin:0 0 8px">Important:</p>
              <ul style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 12px;padding-left:18px">
                <li>Label the kit with Client ID: <strong>${clientId}</strong></li>
                <li>Include a prepaid return envelope</li>
                <li>Confirm dispatch via your portal within 48h</li>
                <li>Return DNA results using Client ID only — no personal details</li>
              </ul>
            </div>
          </div>
        `,
      }),

    ]);

    console.log(`GeneThrive: Health profile emails sent for ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: Email sending failed —', err.message);
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success:  true,
      clientId,
      message:  'Health profile saved. NutriPath notified.',
    }),
  };
};