const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');

dotenv.config();

const stripe = require('./src/config/stripe');
const shopify = require('./src/config/shopify');
const paymentController = require('./src/controllers/paymentController');

const app = express();
const port = process.env.PORT || 3000;

// Raw body parser for webhooks is crucial for verifying signatures
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook for Order Create (Initial Split)
app.post('/api/webhooks/shopify/order-create', paymentController.handleOrderCreate);

// Webhook for Order Update (Milestone Releases)
app.post('/api/webhooks/shopify/order-update', paymentController.handleOrderUpdate);

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('GeneThrive Middleware is Active');
});

app.listen(port, () => {
  console.log(`GeneThrive Middleware listening at http://localhost:${port}`);
});
