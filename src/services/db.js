// Placeholder for a real database (Postgres/Firebase)
// In production, this should be replaced with actual DB calls.

const db = {
  orders: {},
  
  // Save or update an order
  saveOrder: async (orderId, data) => {
    console.log(`[DB] Saving order ${orderId}:`, data);
    db.orders[orderId] = { ...db.orders[orderId], ...data };
    return db.orders[orderId];
  },

  // Retrieve an order
  getOrder: async (orderId) => {
    return db.orders[orderId];
  },

  // Check if a transfer has already been made OR is pending
  hasTransfer: async (orderId, milestoneKey) => {
     const order = db.orders[orderId];
     return order && order.transfers && (order.transfers[milestoneKey]?.status === 'completed');
  },

  // Log a successful transfer
  logTransfer: async (orderId, milestoneKey, transferId, amount, status = 'completed') => {
    if (!db.orders[orderId]) db.orders[orderId] = { transfers: {} };
    if (!db.orders[orderId].transfers) db.orders[orderId].transfers = {};
    
    db.orders[orderId].transfers[milestoneKey] = {
      id: transferId,
      amount: amount,
      status: status,
      timestamp: new Date()
    };
    console.log(`[DB] Logged transfer for ${orderId} - ${milestoneKey}: ${status} (${transferId || 'N/A'})`);
  }
};

module.exports = db;
