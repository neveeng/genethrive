/**
 * GeneThrive — Order Status
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/order-status.js
 *
 * CALLED BY: page.order-tracking.liquid
 *
 * GET /.netlify/functions/order-status?id=GT-1234-abc123
 *
 * Returns the client's current stage and key timestamps from order_sla.
 * NO health data is exposed — only SLA/logistics fields.
 *
 * ENVIRONMENT VARIABLES:
 *   SUPABASE_URL         https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY service_role key
 * ─────────────────────────────────────────────────────────────────────────────
 */

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET')    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  const clientId = event.queryStringParameters?.id?.trim();

  if (!clientId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing id parameter' }),
    };
  }

  // Basic format check — must contain GT- (case-insensitive)
  if (!clientId.toUpperCase().startsWith('GT-')) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Reference numbers start with GT- (e.g. GT-1234-abc123)' }),
    };
  }

  try {
    // Fetch only the SLA/logistics columns — NO health data columns
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/order_sla` +
      `?client_id=ilike.${encodeURIComponent(clientId)}` +
      `&select=current_stage,stage_entered_at,payment_received_at,health_profile_submitted_at,` +
      `kit_dispatched_at,swab_returned_at,dna_results_received_at,barbara_reviewed_at,` +
      `supplement_list_sent_at,tsi_shipped_at` +
      `&limit=1`,
      {
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );

    if (!res.ok) {
      console.error('GeneThrive order-status: Supabase error', res.status);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Could not retrieve order status' }),
      };
    }

    const rows = await res.json();

    if (!rows || rows.length === 0) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Reference number not found. Please check and try again.' }),
      };
    }

    const row = rows[0];

    // Map internal column names to stage keys the frontend understands
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        currentStage: row.current_stage || 'health_profile',
        timestamps: {
          health_profile: row.health_profile_submitted_at,
          kit_dispatch:   row.kit_dispatched_at,
          swab_return:    row.swab_returned_at,
          sequencing:     row.dna_results_received_at,
          barbara_review: row.barbara_reviewed_at,
          compounding:    row.supplement_list_sent_at,
          shipped:        row.tsi_shipped_at,
        },
      }),
    };

  } catch (err) {
    console.error('GeneThrive order-status: error —', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Server error — please try again shortly' }),
    };
  }
};