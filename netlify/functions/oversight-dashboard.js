/**
 * GeneThrive — Oversight Dashboard Data
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/oversight-dashboard.js
 *
 * CALLED BY: paul-dashboard.html
 *
 * WHAT IT DOES:
 *   Reads order_sla from Supabase and returns SLA status for every
 *   active order. No clinical content ever returned.
 *
 * ENVIRONMENT VARIABLES:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   OVERSIGHT_TOKEN (Paul's access token — set in Netlify)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');

function verifyToken(token) {
  return token === process.env.OVERSIGHT_TOKEN;
}

const SLA_RULES = [
  { key: 'kit_dispatch',   label: 'Kit dispatched',     start: 'address_sent_to_nutripath_at', end: 'kit_dispatched_at',       hours: 48 },
  { key: 'swab_return',    label: 'Swab returned',      start: 'kit_dispatched_at',            end: 'swab_returned_at',         hours: 168 }, // 7 days
  { key: 'dna_results',    label: 'DNA results in',     start: 'swab_returned_at',             end: 'dna_results_received_at',  hours: 168 },
  { key: 'barbara_review', label: 'Barbara reviewed',   start: 'dna_results_received_at',      end: 'barbara_reviewed_at',      hours: 48 },
  { key: 'tsi_script',     label: 'TSI script opened',  start: 'supplement_list_sent_at',      end: 'tsi_script_opened_at',     hours: 24 },
  { key: 'tsi_shipped',    label: 'TSI shipped',        start: 'tsi_script_opened_at',         end: 'tsi_shipped_at',           hours: 72 },
];

function getSLAStatus(row, rule) {
  const start = row[rule.start];
  const end   = row[rule.end];

  if (!start) return 'not_started';
  if (end)    return 'complete';

  const elapsed = (Date.now() - new Date(start).getTime()) / (1000 * 60 * 60);
  if (elapsed > rule.hours)           return 'overdue';
  if (elapsed > rule.hours * 0.75)    return 'warning';
  return 'on_track';
}

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Oversight-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET')    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // Verify Paul's token
  const token = event.headers['x-oversight-token'];
  if (!verifyToken(token)) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Read order_sla from Supabase — NO clinical content
  let orders = [];
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/order_sla?order=created_at.desc&limit=100`,
      {
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    orders = await res.json();
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not fetch orders' }) };
  }

  // Read pending escalations
  let escalations = [];
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/sla_escalations?resolved=eq.false&order=fired_at.desc`,
      {
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    escalations = await res.json();
  } catch { /* non-fatal */ }

  // Build dashboard rows
  const rows = orders.map(row => {
    const sla = {};
    let worstStatus = 'complete';

    for (const rule of SLA_RULES) {
      const status = getSLAStatus(row, rule);
      sla[rule.key] = { status, label: rule.label };
      if (status === 'overdue')    worstStatus = 'overdue';
      else if (status === 'warning' && worstStatus !== 'overdue') worstStatus = 'warning';
      else if (status === 'on_track' && worstStatus === 'complete') worstStatus = 'on_track';
      else if (status === 'not_started' && worstStatus === 'complete') worstStatus = 'complete';
    }

    // Overall step
    let step = 'Payment received';
    if (row.health_profile_submitted_at) step = 'Health profile complete';
    if (row.kit_dispatched_at)           step = 'Kit dispatched';
    if (row.swab_returned_at)            step = 'Swab returned';
    if (row.dna_results_received_at)     step = 'DNA results in';
    if (row.barbara_reviewed_at)         step = 'Barbara reviewed';
    if (row.supplement_list_sent_at)     step = 'Script sent to TSI';
    if (row.tsi_script_opened_at)        step = 'TSI compounding';
    if (row.tsi_shipped_at)              step = 'Vitamins shipped';

    const orderEscalations = escalations.filter(e => e.client_id === row.client_id);

    return {
      clientId:      row.client_id,
      orderNumber:   row.shopify_order_number,
      createdAt:     row.created_at,
      currentStep:   step,
      status:        row.subscription_status,
      worstSLA:      worstStatus,
      sla,
      escalations:   orderEscalations.map(e => e.rule),
    };
  });

  // Summary counts
  const summary = {
    total:    rows.length,
    overdue:  rows.filter(r => r.worstSLA === 'overdue').length,
    warning:  rows.filter(r => r.worstSLA === 'warning').length,
    on_track: rows.filter(r => r.worstSLA === 'on_track').length,
    complete: rows.filter(r => r.worstSLA === 'complete').length,
  };

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ rows, summary, generatedAt: new Date().toISOString() }),
  };
};