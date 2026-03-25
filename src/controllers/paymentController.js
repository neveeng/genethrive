const stripe = require('../config/stripe');
const db = require('../services/db');

// Payment Configuration (Can also be moved to a config file)
const SPLIT_CONFIG = {
  nutripath: {
    amount: 27500, // $275.00 in cents
    description: 'Initial GeneThrive Payment - Nutripath Share',
    accountIdEnv: 'NUTRIPATH_STRIPE_ID' 
  },
  pharmacist: {
    amount: 14000, // $140.00
    description: 'Milestone: Pickup Booking - Pharmacist Share',
    // This might be dynamic based on the specific pharmacist assigned to the order
    // For now, we'll assume a single account or a lookup function
    defaultAccountIdEnv: 'PHARMACIST_DEFAULT_STRIPE_ID' 
  },
  naturopath: {
    amount: 6500, // $65.00
    description: 'Milestone: CIL Completion - Naturopath Share',
     // Similarly, might be dynamic
    defaultAccountIdEnv: 'NATUROPATH_DEFAULT_STRIPE_ID'
  },
  ops: {
      amount: 9500, // $95.00 - Retained by Platform, so no transfer needed usually, 
                    // unless "Ops" is a separate entity from the Platform account owner.
      description: 'GeneThrive Ops/Platform Fee'
  }
};

const handleOrderCreate = async (req, res) => {
  try {
    const order = req.body;
    console.log(`[Order Create] Received order: ${order.id}`);

    // 1. Validate Order (Check if it contains the GeneThrive Kit)
    const hasKit = order.line_items.some(item => 
      item.title.toLowerCase().includes('genethrive') || 
      item.sku === 'GT-INIT-KIT' // Replace with actual SKU
    );

    if (!hasKit) {
      console.log(`[Order Create] Order ${order.id} does not contain GeneThrive Kit. Skipping.`);
      return res.status(200).send('Skipped - No Kit');
    }

    // 2. Immediate Transfer to Nutripath ($275)
    // Idempotency check
    const existingTransfer = await db.hasTransfer(order.id, 'nutripath_initial');
    if (existingTransfer) {
        console.log(`[Order Create] Transfer already exists for order ${order.id}. Skipping.`);
        return res.status(200).send('Already Processed');
    }

    const nutripathAccountId = process.env[SPLIT_CONFIG.nutripath.accountIdEnv];
    if (!nutripathAccountId) {
        console.error('Nutripath Stripe Account ID missing in .env');
        return res.status(500).send('Configuration Error');
    }

    // Execute Transfer
    const transfer = await stripe.transfers.create({
      amount: SPLIT_CONFIG.nutripath.amount,
      currency: 'usd', // Adjust currency as needed (e.g., 'aud')
      destination: nutripathAccountId,
      transfer_group: `ORDER_${order.id}`, // Link transfers to the order
      metadata: {
        shopify_order_id: order.id,
        type: 'immediate_split'
      }
    });

    // 3. Log Success
    await db.logTransfer(order.id, 'nutripath_initial', transfer.id, SPLIT_CONFIG.nutripath.amount);
    
    // 4. Create Anonymized Record (Placeholder)
    // await createAnonymizedRecord(order);

    res.status(200).send('Order Processed - Nutripath Transfer Initiated');

  } catch (error) {
    console.error(`[Order Create] Error processing order ${req.body.id}:`, error);
    res.status(500).send('Internal Server Error');
  }
};

const handleOrderUpdate = async (req, res) => {
  try {
    const order = req.body;
    console.log(`[Order Update] Processing update for order: ${order.id}`);

    // Milestone 1: Pharmacist (Pickup Booking) - Triggered by Tag or Attribute
    if (checkMilestoneTrigger(order, 'booked_pickup')) {
        await processMilestoneTransfer(order, 'pharmacist', SPLIT_CONFIG.pharmacist);
    }

    // Milestone 2: Naturopath (CIL Completion) - Triggered by Tag
    if (checkMilestoneTrigger(order, 'CIL_COMPLETE')) {
        await processMilestoneTransfer(order, 'naturopath', SPLIT_CONFIG.naturopath);
    }

    res.status(200).send('Order Update Processed');

  } catch (error) {
     console.error(`[Order Update] Error processing order ${req.body.id}:`, error);
     res.status(500).send('Internal Server Error');
  }
};

// Helper to check tags
const checkMilestoneTrigger = (order, tagToFind) => {
    if (!order.tags) return false;
    const tags = order.tags.split(',').map(t => t.trim());
    return tags.includes(tagToFind);
};

// Helper to process a milestone transfer
const processMilestoneTransfer = async (order, roleKey, config) => {
    const transferKey = `${roleKey}_milestone`;
    
    // 1. Idempotency Check
    const processed = await db.hasTransfer(order.id, transferKey);
    if (processed) {
        console.log(`[Milestone] ${roleKey} transfer already processed for order ${order.id}.`);
        return;
    }

    // 2. Resolve Destination Account
    // In a real app, you'd lookup the specific provider assigned to this order
    // For MVP, we use the env variable.
    const destinationId = process.env[config.defaultAccountIdEnv]; 
    if (!destinationId) {
        console.error(`[Milestone] No Stripe Account ID found for ${roleKey}`);
        return;
    }

    // 3. Execute Transfer
    const transfer = await stripe.transfers.create({
        amount: config.amount,
        currency: 'usd',
        destination: destinationId,
        transfer_group: `ORDER_${order.id}`,
        metadata: {
            shopify_order_id: order.id,
            milestone: roleKey
        }
    });

    // 4. Log
    await db.logTransfer(order.id, transferKey, transfer.id, config.amount);
    console.log(`[Milestone] Successfully transferred $${config.amount/100} to ${roleKey} for order ${order.id}`);
};

module.exports = {
  handleOrderCreate,
  handleOrderUpdate
};
