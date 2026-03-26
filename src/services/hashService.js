const crypto = require('crypto');
const axios = require('axios');

async function getImageHash(fileUrl) {
  const res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return crypto.createHash('md5').update(res.data).digest('hex');
}

module.exports = { getImageHash };
