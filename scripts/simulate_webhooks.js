const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/webhooks/shopify';
const ORDER_ID = 123456789;

const mockOrder = {
  id: ORDER_ID,
  email: 'customer@example.com',
  total_price: '575.00',
  line_items: [
    {
      id: 1,
      title: 'GeneThrive Initial Kit',
      sku: 'GT-INIT-KIT',
      price: '575.00',
      quantity: 1
    }
  ],
  tags: ''
};

const simulate = async () => {
  console.log('--- Phase 1: Initial Order (Should trigger $275 Nutripath split) ---');
  try {
    const res1 = await axios.post(`${BASE_URL}/order-create`, mockOrder);
    console.log('Status:', res1.status, '-', res1.data);
  } catch (err) {
    console.error('Error in Phase 1:', err.response ? err.response.data : err.message);
  }

  console.log('\n--- Phase 2: Pickup Booked (Should trigger $140 Pharmacist split) ---');
  try {
    const updatedOrder1 = { ...mockOrder, tags: 'booked_pickup' };
    const res2 = await axios.post(`${BASE_URL}/order-update`, updatedOrder1);
    console.log('Status:', res2.status, '-', res2.data);
  } catch (err) {
    console.error('Error in Phase 2:', err.response ? err.response.data : err.message);
  }

  console.log('\n--- Phase 3: CIL Completed (Should trigger $65 Naturopath split) ---');
  try {
    const updatedOrder2 = { ...mockOrder, tags: 'booked_pickup, CIL_COMPLETE' };
    const res3 = await axios.post(`${BASE_URL}/order-update`, updatedOrder2);
    console.log('Status:', res3.status, '-', res3.data);
  } catch (err) {
    console.error('Error in Phase 3:', err.response ? err.response.data : err.message);
  }

  console.log('\n--- Phase 4: Re-running Phase 3 (Should be skipped - Idempotency Check) ---');
  try {
    const updatedOrder2 = { ...mockOrder, tags: 'booked_pickup, CIL_COMPLETE' };
    const res4 = await axios.post(`${BASE_URL}/order-update`, updatedOrder2);
    console.log('Status:', res4.status, '-', res4.data);
  } catch (err) {
    console.error('Error in Phase 4:', err.response ? err.response.data : err.message);
  }
};

simulate();
