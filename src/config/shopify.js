const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('dotenv').config();

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
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false, 
});

module.exports = shopify;
