const crypto = require('crypto');

/**
 * Generates a unique, anonymized ID for a client.
 * Format: GT-XXXX-XXXX (where X is a random alphanumeric)
 */
const generateGeneThriveId = () => {
  const segment1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const segment2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `GT-${segment1}-${segment2}`;
};

module.exports = {
  generateGeneThriveId
};
