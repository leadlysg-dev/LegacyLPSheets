/**
 * Netlify Function: submit-lead
 * One endpoint that fans a form submission out to BOTH:
 *   1) Google Sheets — appended to a tab named for TODAY in Singapore time
 *      (e.g. "Jul 4, 2026"); the dated tab is auto-created with a bold, frozen header.
 *   2) GoHighLevel   — forwarded to your GHL Inbound Webhook (server-side JSON).
 * The two run independently: if one fails, the other still goes through.
 *
 * PLACE THIS FILE AT:  netlify/functions/submit-lead.js
 *
 * NETLIFY ENVIRONMENT VARIABLES:
 *   For Google Sheets:
 *     GOOGLE_SERVICE_ACCOUNT_EMAIL   ...@...iam.gserviceaccount.com
 *     GOOGLE_PRIVATE_KEY             the "private_key" from the service account JSON
 *     SHEET_ID                       the ID in the sheet URL: /d/<THIS_PART>/edit
 *   For GoHighLevel:
 *     GHL_WEBHOOK_URL                your GHL Inbound Webhook URL
 *   (Leave the Sheets vars OR the GHL var blank to disable that destination.)
 *
 * No npm install needed. Node 18+ (Netlify default) has fetch + crypto + Intl.
 */

const crypto = require('crypto');

const HEADERS = [
  'Date Added (SGT)', 'Name', 'Mobile',
  'Age', 'Target Retire Age', 'Desired Monthly Income', 'Preparedness', 'Has Plan',
  'Estate Done', 'Estate Gaps (call notes)', 'Consent',
  'Source', 'UTM Campaign', 'UTM Content (Ad)', 'UTM Term (Ad Set)', 'FBCLID', 'Landing URL'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ---- Singapore date/time helpers ----
function sgt(date) {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore', month: 'short', day: 'numeric', year: 'numeric'
  }).format(date);                                   // "Jul 4, 2026"  (tab name)
  const stamp = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);                                   // "Jul 4, 2026, 10:52 PM"
  return { tab: day, stamp: stamp };
}

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing Google service account env vars');

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  };
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(claims));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned); signer.end();
  const signature = signer.sign(key).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + signature
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

const SHEET = () => process.env.SHEET_ID;

async function listTabs(token) {
  const res = await fetch(
    'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET() + '?fields=sheets.properties(sheetId,title)',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error('Metadata read failed: ' + JSON.stringify(data));
  return (data.sheets || []).map(function (s) { return s.properties; });
}

async function addTab(token, title) {
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SHEET() + ':batchUpdate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: title } } }] })
  });
  const data = await res.json();
  if (!res.ok) {
    if (JSON.stringify(data).indexOf('already exists') > -1) return null; // race: created a moment ago
    throw new Error('addSheet failed: ' + JSON.stringify(data));
  }
  return data.replies[0].addSheet.properties.sheetId;
}

async function styleHeader(token, sheetId) {
  try {
    await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SHEET() + ':batchUpdate', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          { updateSheetProperties: { properties: { sheetId: sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
          { repeatCell: { range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } }
        ]
      })
    });
  } catch (e) { /* styling is best-effort */ }
}

async function appendRow(token, tab, values) {
  const range = encodeURIComponent("'" + tab + "'!A1"); // quotes: tab name has spaces/comma
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET() +
    '/values/' + range + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] })
  });
  if (!res.ok) throw new Error('Append failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

// ---- Destination 1: Google Sheets ----
async function writeToSheet(d) {
  if (!process.env.SHEET_ID) return 'skipped';
  const token = await getAccessToken();
  const today = sgt(new Date());

  const tabs = await listTabs(token);
  const exists = tabs.filter(function (t) { return t.title === today.tab; })[0];
  if (!exists) {
    const newId = await addTab(token, today.tab);
    await appendRow(token, today.tab, HEADERS);
    if (newId != null) await styleHeader(token, newId);
  }

  await appendRow(token, today.tab, [
    today.stamp,
    d.full_name || '', d.mobile || d.phone || '',
    d.age_band || '', d.target_retire_age || '', d.desired_monthly_income || '',
    d.preparedness || '', d.has_retirement_plan || '',
    d.estate_done_text || '', d.estate_gaps_text || '', d.consent ? 'Yes' : 'No',
    d.source || '', d.utm_campaign || '', d.utm_content || '', d.utm_term || '',
    d.fbclid || '', d.landing_url || ''
  ]);
  return today.tab;
}

// ---- Destination 2: GoHighLevel ----
async function forwardToGHL(d) {
  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) return 'skipped';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(d)
  });
  if (!res.ok) throw new Error('GHL responded ' + res.status + ': ' + await res.text());
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  let d;
  try { d = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  // run both destinations independently — one failing never blocks the other
  const settled = await Promise.allSettled([ writeToSheet(d), forwardToGHL(d) ]);
  const result = { ok: false, sheet: null, ghl: null, errors: {} };

  if (settled[0].status === 'fulfilled') result.sheet = settled[0].value;
  else result.errors.sheet = String(settled[0].reason);

  if (settled[1].status === 'fulfilled') result.ghl = settled[1].value;
  else result.errors.ghl = String(settled[1].reason);

  // "ok" if at least one real destination succeeded
  result.ok = (result.sheet && result.sheet !== 'skipped') || (result.ghl === true);

  return {
    statusCode: result.ok ? 200 : 500,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
    body: JSON.stringify(result)
  };
};
