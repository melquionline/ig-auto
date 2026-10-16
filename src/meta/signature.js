import crypto from 'node:crypto';
import { config } from '../config.js';

// Meta assina o corpo cru com HMAC-SHA256 usando o App Secret
export function isValidSignature(rawBody, header) {
  if (!header || !config.appSecret || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
