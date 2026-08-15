const QRCode = require("qrcode");
const { ensureTunnel } = require("./devtunnel-util");

/**
 * @param {object} config
 * @param {number} config.port
 * @param {string} config.tunnelId
 * @param {string} config.repo - absolute path of the repo to pair
 * @returns {Promise<{ ws: string, repo: string, dataUrl: string }>}
 */
function generateQR(config) {
  const { port, tunnelId, repo } = config;
  const wsUrl = ensureTunnel(tunnelId, port);
  const payload = JSON.stringify({ ws: wsUrl, repo });

  return new Promise((resolve, reject) => {
    QRCode.toDataURL(payload, { width: 280 }, (err, dataUrl) => {
      if (err) return reject(err);
      resolve({ ws: wsUrl, repo, dataUrl });
    });
  });
}

module.exports = { generateQR };
