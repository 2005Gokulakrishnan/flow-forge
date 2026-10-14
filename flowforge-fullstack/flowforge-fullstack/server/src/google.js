const { google } = require('googleapis');
const prisma = require('./db');
const { encrypt, decrypt } = require('./crypto');
const config = require('./config');
const SCOPES = ['openid','email','profile','https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/drive.metadata.readonly'];
function oauthClient() { return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALLBACK_URL); }
function getAuthUrl(state) { return oauthClient().generateAuthUrl({ access_type:'offline', prompt:'consent', scope:SCOPES, state }); }
async function saveTokens(userId, tokens, profile) {
  const current = await prisma.googleConnection.findUnique({ where:{ userId_provider:{ userId, provider:'google' } } });
  const data = { googleEmail: profile?.email || current?.googleEmail, encryptedAccessToken: encrypt(tokens.access_token) || current?.encryptedAccessToken, encryptedRefreshToken: encrypt(tokens.refresh_token) || current?.encryptedRefreshToken, tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : current?.tokenExpiry, scopes: tokens.scope || current?.scopes };
  return prisma.googleConnection.upsert({ where:{ userId_provider:{ userId, provider:'google' } }, create:{ userId, ...data }, update:data });
}
async function authForUser(userId) {
  const c = await prisma.googleConnection.findUnique({ where:{ userId_provider:{ userId, provider:'google' } } });
  if (!c) throw Object.assign(new Error('Google account is not connected. Connect it in Settings first.'), { status:400 });
  const client = oauthClient(); client.setCredentials({ access_token:decrypt(c.encryptedAccessToken), refresh_token:decrypt(c.encryptedRefreshToken), expiry_date:c.tokenExpiry?.getTime() });
  client.on('tokens', async tokens => { try { await saveTokens(userId, tokens, {email:c.googleEmail}); } catch(e) { console.error('Token refresh persistence failed',e.message); } });
  return client;
}
async function listSpreadsheets(userId) {
  const auth = await authForUser(userId); const drive = google.drive({version:'v3',auth});
  const r = await drive.files.list({ q:"mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", fields:'files(id,name,webViewLink,modifiedTime)', pageSize:100, orderBy:'modifiedTime desc' });
  return r.data.files || [];
}
async function listTabs(userId, spreadsheetId) {
  const auth = await authForUser(userId); const sheets = google.sheets({version:'v4',auth});
  const r = await sheets.spreadsheets.get({spreadsheetId, fields:'spreadsheetId,properties(title),sheets.properties'});
  return { title:r.data.properties.title, sheets:(r.data.sheets||[]).map(s=>({sheetId:s.properties.sheetId,title:s.properties.title,index:s.properties.index})) };
}
async function appendRow(userId, {spreadsheetId, range, values, valueInputOption='USER_ENTERED'}) {
  if (!spreadsheetId || !range || !Array.isArray(values)) throw new Error('Google Sheets append requires spreadsheetId, range and values array.');
  const auth = await authForUser(userId); const sheets = google.sheets({version:'v4',auth});
  const r = await sheets.spreadsheets.values.append({ spreadsheetId, range, valueInputOption, insertDataOption:'INSERT_ROWS', requestBody:{values:[values]} });
  return { updatedRange:r.data.updates?.updatedRange, updatedRows:r.data.updates?.updatedRows, spreadsheetId };
}
module.exports = { oauthClient, getAuthUrl, saveTokens, authForUser, listSpreadsheets, listTabs, appendRow, SCOPES };
