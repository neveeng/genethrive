/**
 * GeneThrive — Order Paid → PDF Generation + Partner Email Routing
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/process-order.js
 *
 * TRIGGERED BY: Shopify "orders/paid" webhook
 *
 * WHAT IT DOES:
 *   1. Verifies the request came from Shopify (HMAC check)
 *   2. Reads order data + health attributes
 *   3. Generates Client ID: GT-{orderNumber}-{shortHash}
 *   4. Builds PDF 1 — Partner/Lab PDF (Client ID only, no PII)
 *   5. Builds PDF 2 — Ops PDF (full details, payment splits)
 *   6. Emails PDF 1 to DNA lab
 *   7. Emails PDF 2 to ops team
 *   8. Sends confirmation email to client
 *
 * DEPENDENCIES — add to package.json and run npm install:
 *   npm install pdf-lib nodemailer
 *
 * ENVIRONMENT VARIABLES (add to Netlify + .env):
 *   SHOPIFY_WEBHOOK_SECRET   = whsec_xxxx   (from Shopify webhook setup)
 *   SHOPIFY_STORE_DOMAIN     = your-store.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN      = shpat_xxxx
 *   SMTP_HOST                = smtp.gmail.com  (or your mail provider)
 *   SMTP_PORT                = 587
 *   SMTP_USER                = orders@genethrive.com
 *   SMTP_PASS                = your-app-password
 *   EMAIL_FROM               = GeneThrive Orders <orders@genethrive.com>
 *   EMAIL_LAB                = lab@nutripath.com.au
 *   EMAIL_OPS                = ops@genethrive.com
 *   EMAIL_REPLY_TO           = support@genethrive.com
 *
 * SETUP:
 *   1. Deploy to Netlify (npm install first)
 *   2. Register webhook in Shopify:
 *        Settings → Notifications → Webhooks → Create webhook
 *        Event:  Order payment
 *        Format: JSON
 *        URL:    https://your-site.netlify.app/.netlify/functions/process-order
 *   3. Copy the webhook signing secret → add as SHOPIFY_WEBHOOK_SECRET
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a deterministic Client ID from the order number and order ID.
 * Format: GT-{orderNumber}-{first6charsOfHash}
 * e.g.  GT-1042-a3f9c2
 */
function generateClientId(orderNumber, orderId) {
  const hash = crypto
    .createHash('sha256')
    .update(String(orderId))
    .digest('hex')
    .slice(0, 6);
  return `GT-${orderNumber}-${hash}`;
}

/**
 * Extract health_* attributes from Shopify order note_attributes array
 * into a clean key/value object.
 */
function extractHealthData(noteAttributes = []) {
  const health = {};
  for (const attr of noteAttributes) {
    if (attr.name.startsWith('health_')) {
      // Strip the "health_" prefix for cleaner display
      const key = attr.name.replace('health_', '');
      health[key] = attr.value || '—';
    }
  }
  return health;
}

/**
 * Format a Shopify money value (in cents) to a dollar string.
 * e.g. 57500 → "$575.00"
 */
function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

const COLORS = {
  sage:    rgb(0.29, 0.40, 0.25),
  ink:     rgb(0.11, 0.11, 0.10),
  soft:    rgb(0.48, 0.48, 0.45),
  border:  rgb(0.84, 0.81, 0.76),
  cream:   rgb(0.97, 0.96, 0.93),
  white:   rgb(1, 1, 1),
  amber:   rgb(0.69, 0.54, 0.31),
  red:     rgb(0.73, 0.18, 0.18),
};

/**
 * Sanitize text for WinAnsi encoding used by pdf-lib StandardFonts.
 * Replaces common special characters with ASCII equivalents.
 */
function sanitizeText(text) {
  if (!text) return '—';
  return String(text)
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/↑/g, '^')
    .replace(/↓/g, 'v')
    .replace(/–/g, '-')
    .replace(/—/g, '-')
    .replace(/•/g, '*')
    .replace(/·/g, '.')
    .replace(/"/g, '"')
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/…/g, '...')
    .replace(/™/g, 'TM')
    .replace(/®/g, '(R)')
    .replace(/©/g, '(C)')
    .replace(/[^\x00-\xFF]/g, ''); // strip anything outside Latin-1
}

/**
 * Draw a horizontal rule line on the PDF page.
 */
function drawRule(page, y, { width = 515, x = 40, color = COLORS.border } = {}) {
  page.drawLine({
    start: { x, y },
    end:   { x: x + width, y },
    thickness: 0.5,
    color,
  });
}

/**
 * Draw a labelled row (left label, right value) — used for data tables.
 */
function drawRow(page, fonts, y, label, value, { bold = false } = {}) {
  page.drawText(sanitizeText(label), {
    x: 40, y,
    size: 10,
    font: fonts.regular,
    color: COLORS.soft,
  });
  page.drawText(sanitizeText(value), {
    x: 220, y,
    size: 10,
    font: bold ? fonts.bold : fonts.regular,
    color: COLORS.ink,
    maxWidth: 330,
  });
  return y - 18; // return next Y position
}

/**
 * Draw a section heading with a coloured background bar.
 */
function drawSectionHeading(page, fonts, y, text) {
  page.drawRectangle({
    x: 40, y: y - 4,
    width: 515,
    height: 20,
    color: COLORS.cream,
  });
  page.drawText(sanitizeText(text).toUpperCase(), {
    x: 46, y,
    size: 8,
    font: fonts.bold,
    color: COLORS.sage,
    characterSpacing: 1,
  });
  return y - 26;
}

/**
 * Draw the GeneThrive page header (logo text + document title).
 */
function drawHeader(page, fonts, title, subtitle) {
  // Brand bar
  page.drawRectangle({ x: 0, y: 782, width: 595, height: 60, color: COLORS.sage });
  page.drawText('GENETHRIVE', {
    x: 40, y: 808,
    size: 16,
    font: fonts.bold,
    color: COLORS.white,
    characterSpacing: 3,
  });
  page.drawText('Personalised Nutrition', {
    x: 40, y: 793,
    size: 9,
    font: fonts.regular,
    color: rgb(0.75, 0.87, 0.72),
  });

  // Document title area
  page.drawText(title, {
    x: 40, y: 758,
    size: 14,
    font: fonts.bold,
    color: COLORS.ink,
  });
  if (subtitle) {
    page.drawText(subtitle, {
      x: 40, y: 742,
      size: 9,
      font: fonts.regular,
      color: COLORS.soft,
    });
  }
  drawRule(page, 734);
  return 718; // starting Y for content
}

/**
 * Draw a footer with page number and confidentiality notice.
 */
function drawFooter(page, fonts, text) {
  drawRule(page, 44);
  page.drawText(sanitizeText(text), {
    x: 40, y: 30,
    size: 8,
    font: fonts.regular,
    color: COLORS.soft,
  });
  page.drawText('CONFIDENTIAL', {
    x: 490, y: 30,
    size: 8,
    font: fonts.bold,
    color: COLORS.soft,
    characterSpacing: 1,
  });
}

// ── PDF 1: Partner / Lab PDF (NO PII) ────────────────────────────────────────

/**
 * Generates the anonymised PDF for the DNA test lab.
 * Contains ONLY: Client ID, health profile, test instructions.
 * NO name, address, email, or payment info.
 */
async function generateLabPdf(clientId, health, orderDate) {
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([595, 842]); // A4
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = drawHeader(
    page, fonts,
    'DNA Test Order — Lab Copy',
    `Generated: ${orderDate}   ·   CONFIDENTIAL — anonymised`
  );

  // Client ID block — prominent
  page.drawRectangle({ x: 40, y: y - 36, width: 515, height: 48, color: COLORS.cream });
  page.drawText('CLIENT ID', {
    x: 52, y: y - 14,
    size: 8, font: fonts.bold, color: COLORS.sage, characterSpacing: 1,
  });
  page.drawText(clientId, {
    x: 52, y: y - 30,
    size: 20, font: fonts.bold, color: COLORS.ink,
  });
  page.drawText('Use this ID on all correspondence. Do not add client name or address.', {
    x: 240, y: y - 22,
    size: 8, font: fonts.regular, color: COLORS.soft,
  });
  y -= 58;

  drawRule(page, y);
  y -= 20;

  // Health profile section
  y = drawSectionHeading(page, fonts, y, 'Health Profile');
  y -= 4;

  const healthRows = [
    ['Pregnant / breastfeeding', health.pregnant_breastfeeding],
    ['Diagnosed conditions',     health.conditions],
    ['Conditions detail',        health.conditions_detail],
    ['Prescription medications', health.medications],
    ['Medications detail',       health.medications_detail],
    ['Allergies',                health.allergies],
    ['Allergies detail',         health.allergies_detail],
    ['Gender',                   health.gender],
    ['Age',                      health.age ? `${health.age} years` : '—'],
    ['Intermittent fasting',     health.fasting],
    ['Fasting protocol',         health.fasting_detail],
  ];

  for (const [label, value] of healthRows) {
    if (!value || value === '—' || value === '') continue;
    y = drawRow(page, fonts, y, label, value);
    if (y < 80) break; // safety — don't overflow page
  }

  y -= 10;
  drawRule(page, y);
  y -= 20;

  // Instructions
  y = drawSectionHeading(page, fonts, y, 'Processing Instructions');
  y -= 4;

  const instructions = [
    '1.  Register this test kit using the Client ID above only.',
    '2.  Do not record client name, email, or home address in your system.',
    '3.  Return results to GeneThrive referencing the Client ID.',
    '4.  All result communications must use the Client ID — not personal details.',
    '5.  Retain this document for your records in accordance with privacy obligations.',
  ];

  for (const line of instructions) {
    page.drawText(sanitizeText(line), { x: 46, y, size: 9, font: fonts.regular, color: COLORS.ink });
    y -= 16;
  }

  drawFooter(page, fonts, `GeneThrive Pty Ltd  ·  Lab copy — anonymised  ·  Client ID: ${clientId}`);

  return pdfDoc.save();
}

// ── PDF 2: Ops PDF (FULL DETAILS) ────────────────────────────────────────────

/**
 * Generates the internal ops PDF with full order details,
 * client PII, health data, and payment split breakdown.
 */
async function generateOpsPdf(clientId, order, health) {
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([595, 842]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  const orderDate = new Date(order.created_at).toLocaleDateString('en-AU', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  let y = drawHeader(
    page, fonts,
    'Order Summary — Ops Copy',
    `Order #${order.order_number}  ·  ${orderDate}  ·  INTERNAL USE ONLY`
  );

  // Client identity
  y = drawSectionHeading(page, fonts, y, 'Client Details');
  y -= 4;
  y = drawRow(page, fonts, y, 'Client ID',    clientId, { bold: true });
  y = drawRow(page, fonts, y, 'Full name',    `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim() || order.email);
  y = drawRow(page, fonts, y, 'Email',        order.email);
  y = drawRow(page, fonts, y, 'Phone',        order.phone || order.shipping_address?.phone || '—');
  y = drawRow(page, fonts, y, 'Address',      [
    order.shipping_address?.address1,
    order.shipping_address?.city,
    order.shipping_address?.province,
    order.shipping_address?.zip,
  ].filter(Boolean).join(', ') || '—');

  y -= 10;
  drawRule(page, y);
  y -= 20;

  // Payment splits
  y = drawSectionHeading(page, fonts, y, 'Payment Breakdown — $575.00 Initial');
  y -= 4;
  y = drawRow(page, fonts, y, 'Nutripath (DNA lab)',   '$275.00 — release immediately');
  y = drawRow(page, fonts, y, 'Pharmacist',            '$140.00 — release on pickup confirmation');
  y = drawRow(page, fonts, y, 'Naturopath',            '$65.00 — release on CIL completion');
  y = drawRow(page, fonts, y, 'Ops / GeneThrive',      '$95.00 — retain');
  y -= 6;
  page.drawText('Monthly recurring: $200.00 auto-debit commencing next billing cycle', {
    x: 40, y,
    size: 9, font: fonts.bold, color: COLORS.amber,
  });
  y -= 20;

  drawRule(page, y);
  y -= 20;

  // Health profile
  y = drawSectionHeading(page, fonts, y, 'Health Profile');
  y -= 4;

  const healthRows = [
    ['Pregnant / breastfeeding', health.pregnant_breastfeeding],
    ['Diagnosed conditions',     health.conditions],
    ['Conditions detail',        health.conditions_detail],
    ['Prescription medications', health.medications],
    ['Medications detail',       health.medications_detail],
    ['Allergies',                health.allergies],
    ['Allergies detail',         health.allergies_detail],
    ['Gender',                   health.gender],
    ['Age',                      health.age ? `${health.age} years` : '—'],
    ['Intermittent fasting',     health.fasting],
    ['Fasting protocol',         health.fasting_detail],
  ];

  for (const [label, value] of healthRows) {
    y = drawRow(page, fonts, y, label, value || '—');
    if (y < 80) break;
  }

  y -= 10;
  drawRule(page, y);
  y -= 20;

  // Milestone tracking
  y = drawSectionHeading(page, fonts, y, 'Milestone Checklist');
  y -= 4;

  const milestones = [
    '[ ]  DNA kit dispatched to client',
    '[ ]  Nutripath payment released — $275.00',
    '[ ]  Client pickup confirmed → release pharmacist $140.00',
    '[ ]  CIL consultation completed → release naturopath $65.00',
    '[ ]  Month 2 auto-debit scheduled — $200.00',
  ];

  for (const line of milestones) {
    page.drawText(sanitizeText(line), { x: 46, y, size: 9, font: fonts.regular, color: COLORS.ink });
    y -= 16;
  }

  drawFooter(page, fonts, `GeneThrive Pty Ltd  ·  Order #${order.order_number}  ·  Client ID: ${clientId}  ·  INTERNAL`);

  return pdfDoc.save();
}

// ── Email sender ──────────────────────────────────────────────────────────────

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendLabEmail(transporter, clientId, labPdfBytes, orderDate) {
  await transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to:      process.env.EMAIL_LAB,
    replyTo: process.env.EMAIL_REPLY_TO,
    subject: `New DNA Test Order — ${clientId}`,
    text: [
      `New DNA test order received.`,
      ``,
      `Client ID: ${clientId}`,
      `Date: ${orderDate}`,
      ``,
      `Please find the anonymised test order attached.`,
      `Process this order using the Client ID only — do not add client personal details to your system.`,
      ``,
      `GeneThrive`,
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
        <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
          <span style="color:#fff;font-size:18px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
        </div>
        <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
          <p style="margin:0 0 16px">New DNA test order received.</p>
          <div style="background:#f7f4ee;border-radius:6px;padding:16px;margin-bottom:20px">
            <div style="font-size:11px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:6px">CLIENT ID</div>
            <div style="font-size:22px;font-weight:700;color:#1c1c1a">${clientId}</div>
          </div>
          <p style="margin:0 0 8px;font-size:14px;color:#4a4a46">
            Please find the anonymised test order PDF attached.
          </p>
          <p style="margin:0 0 20px;font-size:14px;color:#4a4a46">
            <strong>Important:</strong> Process this order using the Client ID only.
            Do not add client personal details to your system.
          </p>
          <p style="margin:0;font-size:13px;color:#7a7a74">GeneThrive Ops Team</p>
        </div>
      </div>
    `,
    attachments: [{
      filename:    `GeneThrive-Lab-${clientId}.pdf`,
      content:     Buffer.from(labPdfBytes),
      contentType: 'application/pdf',
    }],
  });
}

async function sendOpsEmail(transporter, clientId, orderNumber, opsPdfBytes, orderDate) {
  await transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to:      process.env.EMAIL_OPS,
    replyTo: process.env.EMAIL_REPLY_TO,
    subject: `New Order #${orderNumber} — ${clientId} — Action Required`,
    text: [
      `New order received and paid.`,
      ``,
      `Order #:   ${orderNumber}`,
      `Client ID: ${clientId}`,
      `Date:      ${orderDate}`,
      ``,
      `Full order details are attached. Please action the milestone checklist.`,
      ``,
      `Immediate actions:`,
      `  1. Release $275.00 to Nutripath`,
      `  2. Dispatch DNA kit to client`,
      `  3. Schedule month 2 auto-debit ($200.00)`,
      ``,
      `GeneThrive`,
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
        <div style="background:#1c1c1a;padding:20px 24px;border-radius:8px 8px 0 0">
          <span style="color:#fff;font-size:18px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
          <span style="color:#888;font-size:13px;margin-left:12px">Internal Order Summary</span>
        </div>
        <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
          <div style="display:flex;gap:16px;margin-bottom:20px">
            <div style="flex:1;background:#f7f4ee;border-radius:6px;padding:14px">
              <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px">ORDER</div>
              <div style="font-size:18px;font-weight:700">#${orderNumber}</div>
            </div>
            <div style="flex:1;background:#f7f4ee;border-radius:6px;padding:14px">
              <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px">CLIENT ID</div>
              <div style="font-size:18px;font-weight:700">${clientId}</div>
            </div>
          </div>
          <p style="font-size:13px;font-weight:600;margin:0 0 10px">Immediate actions required:</p>
          <ol style="font-size:13px;color:#4a4a46;margin:0 0 20px;padding-left:20px">
            <li style="margin-bottom:6px">Release <strong>$275.00</strong> to Nutripath</li>
            <li style="margin-bottom:6px">Dispatch DNA kit to client</li>
            <li>Schedule month 2 auto-debit — <strong>$200.00</strong></li>
          </ol>
          <p style="font-size:13px;color:#7a7a74;margin:0">Full details and milestone checklist in the attached PDF.</p>
        </div>
      </div>
    `,
    attachments: [{
      filename:    `GeneThrive-Order-${orderNumber}-${clientId}.pdf`,
      content:     Buffer.from(opsPdfBytes),
      contentType: 'application/pdf',
    }],
  });
}

async function sendClientConfirmation(transporter, order, clientId) {
  const firstName = order.shipping_address?.first_name || order.email;
  await transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to:      order.email,
    replyTo: process.env.EMAIL_REPLY_TO,
    subject: `Your GeneThrive order is confirmed — ${clientId}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
        <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
          <span style="color:#fff;font-size:18px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
        </div>
        <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
          <h2 style="margin:0 0 16px;font-size:20px;font-weight:600">Thank you, ${firstName}!</h2>
          <p style="margin:0 0 16px;font-size:14px;color:#4a4a46;line-height:1.6">
            Your order has been received and your DNA test kit will be dispatched shortly.
          </p>
          <div style="background:#e8eee7;border-radius:8px;padding:16px;margin-bottom:20px">
            <div style="font-size:11px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">YOUR REFERENCE</div>
            <div style="font-size:18px;font-weight:700;color:#1c1c1a">${clientId}</div>
            <div style="font-size:12px;color:#7a7a74;margin-top:4px">Keep this handy — use it for any enquiries</div>
          </div>
          <p style="font-size:13px;font-weight:600;margin:0 0 10px;color:#1c1c1a">What happens next:</p>
          <ol style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 24px;padding-left:20px">
            <li>Your DNA test kit arrives in 3–5 business days</li>
            <li>Complete your sample and return using the prepaid envelope</li>
            <li>Our naturopath reviews your DNA results + health profile</li>
            <li>Your personalised vitamin formula is compounded by our pharmacist</li>
            <li>Your first month's vitamins are dispatched to you</li>
          </ol>
          <p style="font-size:13px;color:#7a7a74;margin:0;line-height:1.6">
            Questions? Reply to this email or contact us at
            <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
          </p>
        </div>
      </div>
    `,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async function (event) {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // 1. Verify Shopify HMAC signature
  const shopifyHmac  = event.headers['x-shopify-hmac-sha256'];
  const rawBody      = event.body;
  const computedHmac = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  if (computedHmac !== shopifyHmac) {
    console.warn('GeneThrive: Webhook HMAC verification failed');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // 2. Parse order
  let order;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const orderNumber = order.order_number;
  const orderId     = order.id;
  const orderDate   = new Date(order.created_at).toLocaleDateString('en-AU', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  console.log(`GeneThrive: Processing order #${orderNumber} (ID: ${orderId})`);

  // 3. Generate Client ID
  const clientId = generateClientId(orderNumber, orderId);
  console.log(`GeneThrive: Client ID — ${clientId}`);

  // 4. Extract health data
  const health = extractHealthData(order.note_attributes);
  console.log(`GeneThrive: Health fields found — ${Object.keys(health).length}`);

  // 5. Generate both PDFs
  let labPdfBytes, opsPdfBytes;
  try {
    [labPdfBytes, opsPdfBytes] = await Promise.all([
      generateLabPdf(clientId, health, orderDate),
      generateOpsPdf(clientId, order, health),
    ]);
    console.log('GeneThrive: PDFs generated successfully');
  } catch (err) {
    console.error('GeneThrive: PDF generation failed —', err.message);
    return { statusCode: 500, body: 'PDF generation failed' };
  }

  // 6. Send all emails
  const transporter = createTransporter();
  try {
    await Promise.all([
      sendLabEmail(transporter, clientId, labPdfBytes, orderDate),
      sendOpsEmail(transporter, clientId, orderNumber, opsPdfBytes, orderDate),
      sendClientConfirmation(transporter, order, clientId),
    ]);
    console.log('GeneThrive: All emails sent successfully');
  } catch (err) {
    console.error('GeneThrive: Email sending failed —', err.message);
    // Don't return 500 — PDFs were generated fine.
    // Netlify logs will capture the error for manual follow-up.
  }

  // 7. Tag the order in Shopify so you can filter processed orders in admin
  try {
    const existingTags = order.tags ? order.tags.split(', ') : [];
    existingTags.push('pdf-generated', `client-id:${clientId}`);
    await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders/${orderId}.json`,
      {
        method: 'PUT',
        headers: {
          'Content-Type':           'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
        },
        body: JSON.stringify({ order: { id: orderId, tags: existingTags.join(', ') } }),
      }
    );
    console.log(`GeneThrive: Order #${orderNumber} tagged with client ID`);
  } catch (err) {
    console.warn('GeneThrive: Order tagging failed —', err.message);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, clientId, orderNumber }),
  };
};
