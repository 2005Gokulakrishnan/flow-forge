const crypto = require('crypto');
const key = process.env.TOKEN_ENCRYPTION_KEY ? Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex') : null;
function encrypt(value) {
  if (!value) return null;
  if (!key || key.length !== 32) throw new Error('Set a valid TOKEN_ENCRYPTION_KEY before connecting Google.');
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(':');
}
function decrypt(value) {
  if (!value) return null;
  if (!key || key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY is missing or invalid.');
  const [iv, tag, data] = value.split(':'); const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv,'hex'));
  decipher.setAuthTag(Buffer.from(tag,'hex')); return Buffer.concat([decipher.update(Buffer.from(data,'hex')),decipher.final()]).toString('utf8');
}
module.exports = { encrypt, decrypt };
