/**
 * GeneThrive — Create Stripe PaymentIntent
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/create-payment-intent.js
 *
 * CALLED BY: page.payment.liquid (step 2 of handlePayment())
 *
 * WHAT IT DOES:
 *   1. Creates a Stripe Customer with client's email + details
 *   2. Creates a PaymentIntent for $575 AUD
 *   3. Returns the clientSecret to the browser so Stripe.js can
 *      confirm the card payment securely client-side
 *
 * NOTE: The actual splits, subscription, and PDFs are handled by
 *       finalise-order.js AFTER card payment is confirmed. This
 *       function only sets up the intent.
 *
 * ENVIRONMENT VARIABLES:
 *   STRIPE_SECRET_KEY   = sk_test_xxxx or sk_live_xxxx
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Stripe = require('stripe');

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  let clientDetails;
  try {
    const body   = JSON.parse(event.body);
    clientDetails = body.clientDetails;
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!clientDetails?.email || !clientDetails?.name) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing client email or name' }),
    };
  }

  try {
    // 1. Create or retrieve Stripe Customer
    // Check if customer already exists with this email
    const existing = await stripe.customers.list({ email: clientDetails.email, limit: 1 });

    let customer;
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email: clientDetails.email,
        name:  clientDetails.name,
        phone: clientDetails.phone,
        address: {
          line1:       clientDetails.address,
          city:        clientDetails.suburb,
          state:       clientDetails.state,
          postal_code: clientDetails.postcode,
          country:     'AU',
        },
        metadata: {
          source: 'genethrive-checkout',
        },
      });
    }

    // 2. Create PaymentIntent for $575 AUD
    // setup_future_usage: 'off_session' tells Stripe to save the card
    // for future charges (the $200/month subscription)
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   57500, // in cents
      currency: 'aud',
      customer: customer.id,
      setup_future_usage: 'off_session',
      metadata: {
        customer_name:  clientDetails.name,
        customer_email: clientDetails.email,
        product:        'GeneThrive DNA + First Month Vitamins',
      },
      description: 'GeneThrive — DNA test + first month personalised vitamins',
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        customerId:   customer.id,
      }),
    };

  } catch (err) {
    console.error('GeneThrive create-payment-intent error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};