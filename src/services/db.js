const knex = require('knex')({
  client: 'sqlite3',
  connection: {
    filename: './genethrive.db'
  },
  useNullAsDefault: true
});

// Initialize database schema
const initDB = async () => {
  // 1. Table for Client Anonymization Mapping
  if (!await knex.schema.hasTable('client_mapping')) {
    await knex.schema.createTable('client_mapping', (table) => {
      table.string('shopify_customer_id').primary();
      table.string('genethrive_id').unique().notNullable();
      table.string('shopify_order_id');
      table.timestamp('created_at').defaultTo(knex.fn.now());
    });
    console.log('[DB] Created client_mapping table');
  }

  // 2. Table for Transfer Tracking
  if (!await knex.schema.hasTable('transfers')) {
    await knex.schema.createTable('transfers', (table) => {
      table.increments('id');
      table.string('shopify_order_id').notNullable();
      table.string('milestone_key').notNullable(); // e.g., 'nutripath_initial'
      table.string('stripe_transfer_id');
      table.integer('amount_cents');
      table.string('status').notNullable(); // 'completed', 'pending_top_up'
      table.timestamp('timestamp').defaultTo(knex.fn.now());
      table.unique(['shopify_order_id', 'milestone_key']); // Prevent duplicates
    });
    console.log('[DB] Created transfers table');
  }
};

// Initialize on startup
initDB();

const db = {
  // Get or Create Anonymized ID
  getOrCreateAnonymizedId: async (customerId, orderId) => {
    const existing = await knex('client_mapping')
      .where({ shopify_customer_id: customerId })
      .first();

    if (existing) return existing.genethrive_id;

    const { generateGeneThriveId } = require('../utils/anonymizer');
    const newId = generateGeneThriveId();

    await knex('client_mapping').insert({
      shopify_customer_id: customerId,
      genethrive_id: newId,
      shopify_order_id: orderId
    });

    console.log(`[DB] Created new mapping: ${customerId} -> ${newId}`);
    return newId;
  },

  // Check if a transfer has already been completed
  hasTransfer: async (orderId, milestoneKey) => {
    const transfer = await knex('transfers')
      .where({ shopify_order_id: orderId, milestone_key: milestoneKey })
      .first();
    
    return transfer && transfer.status === 'completed';
  },

  // Log a transfer (Successful or Pending)
  logTransfer: async (orderId, milestoneKey, transferId, amount, status = 'completed') => {
    // Check for existing record to handle retries/updates
    const existing = await knex('transfers')
        .where({ shopify_order_id: orderId, milestone_key: milestoneKey })
        .first();

    if (existing) {
        await knex('transfers')
            .where({ id: existing.id })
            .update({
                stripe_transfer_id: transferId,
                status: status,
                timestamp: knex.fn.now()
            });
    } else {
        await knex('transfers').insert({
            shopify_order_id: orderId,
            milestone_key: milestoneKey,
            stripe_transfer_id: transferId,
            amount_cents: amount,
            status: status
        });
    }
    console.log(`[DB] Logged transfer ${orderId} - ${milestoneKey}: ${status}`);
  }
};

module.exports = db;
