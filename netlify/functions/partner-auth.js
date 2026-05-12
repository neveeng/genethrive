/**
 * GeneThrive — Partner Portal Authentication
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/partner-auth.js
 *
 * Validates partner login credentials and returns a session token.
 * Each portal calls this on login — token is stored in sessionStorage
 * and sent as X-Partner-Token header on subsequent requests.
 *
 * ENVIRONMENT VARIABLES (add to Netlify):
 *   NUTRIPATH_EMAIL     = lab@nutripath.com.au
 *   NUTRIPATH_PASSWORD  = nutripath-secure-password
 *   NATUROPATH_EMAIL    = consult@naturopath.com.au
 *   NATUROPATH_PASSWORD = naturopath-secure-password
 *   PHARMACIST_EMAIL    = compounding@pharmacy.com.au
 *   PHARMACIST_PASSWORD = pharmacist-secure-password
 *   PARTNER_TOKEN_SECRET = a-long-random-string-for-signing-tokens
 *
 * Generate PARTNER_TOKEN_SECRET:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');

// Generate a signed session token valid for 8 hours
function generateToken(partner) {
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  const payload = `${partner}:${expires}`;
  const sig     = crypto
    .createHmac('sha256', process.env.PARTNER_TOKEN_SECRET || 'fallback')
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

// Verify a token and return the partner name, or null if invalid/expired
function verifyToken(token) {
  try {
    const decoded  = Buffer.from(token, 'base64').toString('utf8');
    const parts    = decoded.split(':');
    if (parts.length !== 3) return null;
    const [partner, expires, sig] = parts;
    if (Date.now() > parseInt(expires)) return null;
    const expected = crypto
      .createHmac('sha256', process.env.PARTNER_TOKEN_SECRET || 'fallback')
      .update(`${partner}:${expires}`)
      .digest('hex');
    if (sig !== expected) return null;
    return partner;
  } catch {
    return null;
  }
}

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  let email, password;
  try {
    const body = JSON.parse(event.body);
    email      = body.email?.trim().toLowerCase();
    password   = body.password;
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!email || !password) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing email or password' }) };
  }

  // Check each partner's credentials
  const partners = [
    { key: 'nutripath',  email: process.env.NUTRIPATH_EMAIL,    password: process.env.NUTRIPATH_PASSWORD },
    { key: 'naturopath', email: process.env.NATUROPATH_EMAIL,   password: process.env.NATUROPATH_PASSWORD },
    { key: 'pharmacist', email: process.env.PHARMACIST_EMAIL,   password: process.env.PHARMACIST_PASSWORD },
  ];

  const match = partners.find(p =>
    p.email?.toLowerCase() === email && p.password === password
  );

  if (!match) {
    console.warn(`GeneThrive partner-auth: failed login attempt for ${email}`);
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid email or password' }),
    };
  }

  const token = generateToken(match.key);
  console.log(`GeneThrive partner-auth: ${match.key} logged in`);

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ token, partner: match.key }),
  };
};

// Export verifyToken for use in other functions
exports.verifyToken = verifyToken;