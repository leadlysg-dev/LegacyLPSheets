/**
 * Netlify Function: submit-lead
 * Appends each form submission to a Google Sheet tab named for TODAY in
 * Singapore time (e.g. "Jul 4, 2026"). The dated tab is created automatically
 * — with a bold, frozen header row — the first time a lead comes in that day.
 *
 * PLACE THIS FILE AT:  netlify/functions/submit-lead.js
 *
 * REQUIRED NETLIFY ENVIRONMENT VARIABLES:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL   ...@...iam.gserviceaccount.com
 *   GOOGLE_PRIVATE_KEY             the "private_key" value from the service account JSON
 *   SHEET_ID                       the ID in the sheet URL: /d/<THIS_PART>/edit
 *   (SHEET_TAB is no longer used — tabs are created per day automatically.)
 *
 * No npm install needed. Node 18+ (Netlify default) has fetch + crypto + Intl.
 */

const crypto = require('crypto');

const HEADERS = [
  'Date Added (SGT)', 'Name', 'Mobile', 'Email',
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
  }).format(date);                                   // e.g. "Jul 4, 2026"  (tab name)
  const stamp = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);                                   // e.g. "Jul 4, 2026, 10:52 PM"
  return { tab: day, stamp: stamp };
}

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing service account env vars');

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
  return (data.sheets || []).map(function (s) { return s.properties; }); // [{sheetId, title}]
}

async function addTab(token, title) {
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SHEET() + ':batchUpdate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: title } } }] })
  });
  const data = await res.json();
  if (!res.ok) {
    // If another request created it a moment ago, that's fine — carry on.
    if (JSON.stringify(data).indexOf('already exists') > -1) return null;
    throw new Error('addSheet failed: ' + JSON.stringify(data));
  }
  return data.replies[0].addSheet.properties.sheetId;
}

async function styleHeader(token, sheetId) {
  // best-effort: bold + freeze the header row; never blocks a lead write
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
  } catch (e) { /* ignore styling errors */ }
}

async function appendRow(token, tab, values) {
  const range = encodeURIComponent("'" + tab + "'!A1"); // quotes needed: tab name has spaces/comma
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  try {
    const d = JSON.parse(event.body || '{}');
    const token = await getAccessToken();
    const today = sgt(new Date());

    // find or create today's tab
    const tabs = await listTabs(token);
    const existing = tabs.filter(function (t) { return t.title === today.tab; })[0];
    if (!existing) {
      const newId = await addTab(token, today.tab);
      await appendRow(token, today.tab, HEADERS);
      if (newId != null) await styleHeader(token, newId);
    }

    const row = [
      today.stamp,
      d.full_name || '',
      d.mobile || d.phone || '',
      d.email || '',
      d.age_band || '',
      d.target_retire_age || '',
      d.desired_monthly_income || '',
      d.preparedness || '',
      d.has_retirement_plan || '',
      d.estate_done_text || '',
      d.estate_gaps_text || '',
      d.consent ? 'Yes' : 'No',
      d.source || '',
      d.utm_campaign || '',
      d.utm_content || '',
      d.utm_term || '',
      d.fbclid || '',
      d.landing_url || ''
    ];
    await appendRow(token, today.tab, row);

    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
      body: JSON.stringify({ ok: true, tab: today.tab })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
      body: JSON.stringify({ ok: false, error: String(err) })
    };
  }
};
