export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { customerId, healthData } = req.body;

  // Build metafields array from health data
  const metafields = Object.entries(healthData).map(([key, value]) => ({
    namespace: 'health',
    key: key,
    value: String(value),
    type: 'single_line_text_field'
  }));

  const response = await fetch(
    `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/customers/${customerId}/metafields.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_API_KEY
      },
      body: JSON.stringify({ metafield: metafields[0] }) // loop this for all fields
    }
  );

  const data = await response.json();
  res.status(200).json(data);
}