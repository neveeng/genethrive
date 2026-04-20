exports.handler = async function() {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        opsToken:    process.env.OPS_ADMIN_TOKEN,
        opsPassword: process.env.OPS_PASSWORD,
        allowedOrigin: process.env.ALLOWED_ORIGIN,
    }),
  };
};