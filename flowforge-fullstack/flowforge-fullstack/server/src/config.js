const dotenv = require('dotenv');
dotenv.config();
const required = ['DATABASE_URL','SESSION_SECRET','TOKEN_ENCRYPTION_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_CALLBACK_URL'];
for (const key of required) if (!process.env[key]) console.warn(`[config] ${key} is not configured; related features will not work until set.`);
if (process.env.TOKEN_ENCRYPTION_KEY && !/^[a-fA-F0-9]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY)) throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
module.exports = { port: Number(process.env.PORT || 4000), appUrl: process.env.APP_URL || 'http://localhost:4000', frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4000', origins: (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:4000').split(',').map(x=>x.trim()), isProd: process.env.NODE_ENV === 'production' };
