require('dotenv').config(); // 1. load env vars first
require('@shopify/shopify-api/adapters/node');   // 2. shopify adapter
const { shopifyApi, ApiVersion } = require('@shopify/shopify-api');

// Ensure basic variables are set, though full validation should happen at runtime
if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
  // We'll log a warning here but not crash, as this file might be imported before .env is fully loaded in some setups
  console.warn('Warning: SHOPIFY_API_KEY or SHOPIFY_API_SECRET are missing.');
}

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_orders', 'read_products'],
  hostName: process.env.SHOPIFY_SHOP_DOMAIN || 'localhost',
  apiVersion:ApiVersion.July25,
  isEmbeddedApp: false, 
  future: {
    customerAddressDefaultFix: true,        // fixes 'default' → 'is_default'
    unstable_managedPricingSupport: true,   // only needed if using managed pricing
  },

});

module.exports = shopify;
