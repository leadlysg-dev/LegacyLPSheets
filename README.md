# Legacy Planner — Retirement Assessment Funnel

A single-page landing site (Meta ads → questionnaire → GHL + Google Sheet).

## Files in this package
- `index.html` .................. the landing page (put at repo root)
- `netlify.toml` ................ Netlify config (put at repo root)
- `netlify/functions/submit-lead.js` .. serverless function that writes form data to Google Sheets

## Deploy
1. Push all of these to your Git repo, keeping the folder structure exactly.
2. Netlify (connected to the repo) auto-builds. No `npm install` needed.

============================================================
 SETUP CHECKLIST (do these once)
============================================================

## 1. Meta Pixel  (in index.html)
- Open `index.html`, Find & Replace `YOUR_PIXEL_ID` with your real Pixel ID.
  It appears twice. The Pixel ID must be the same dataset selected in your ad set
  ("Retirement Lead LP").

## 2. Google Sheet via the API  (Netlify environment variables)
Create these in Netlify > Site configuration > Environment variables:
- GOOGLE_SERVICE_ACCOUNT_EMAIL  = service account's ...@...iam.gserviceaccount.com
- GOOGLE_PRIVATE_KEY            = the "private_key" value from the service account JSON
- SHEET_ID                      = the ID in the sheet URL:  /d/<THIS_PART>/edit
  (SHEET_TAB is NOT needed — a new tab is created automatically each day,
   named for the Singapore date, e.g. "Jul 4, 2026".)

How to get the service account:
  a. console.cloud.google.com > create a project
  b. Enable "Google Sheets API"
  c. APIs & Services > Credentials > Create credentials > Service account
  d. Open it > Keys > Add key > Create new key > JSON (downloads a file)
  e. From that JSON copy client_email and private_key into the env vars above
  f. Create your Google Sheet, rename the first tab to "Leads",
     and SHARE the sheet with the client_email address (Editor).  <-- most-missed step
     (You do NOT need to pre-make daily tabs — the function creates each
      day's tab automatically, with a bold, frozen header row.)

## 3. GoHighLevel  (Netlify environment variable + a GHL workflow)
- Add a Netlify env var:  GHL_WEBHOOK_URL = your GHL Inbound Webhook URL
  (The page no longer holds this URL — it's server-side now.)
- In GHL: Automations > Workflows > Trigger "Inbound Webhook" (copy that URL
  into the env var above) > then Create/Update Contact (map phone/email +
  custom fields) > Add Tag.

## 4. Meta ad URL parameters (for attribution)
In each ad's "URL parameters" field, paste:
  utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}

============================================================
 TEST
============================================================
Open the live page, complete the form once. You should see:
- a new row in the Google Sheet (headers auto-created)
- a contact created + tagged in GHL (if configured)
- PageView / InitiateCheckout / Lead firing in Meta (check Pixel Helper)

Troubleshooting the sheet: Netlify > Functions > submit-lead > Logs.
  "permission denied" = you didn't share the sheet with the service account.
  "token error"       = the private key was pasted incorrectly.
