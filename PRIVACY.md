# Privacy Policy for the Jobber Tax Calculator Extension

Effective date: September 5, 2026

The Jobber Tax Calculator Extension is an internal tool published by Steambrite (steambrite.us). It suggests the correct Ohio sales-tax jurisdiction and matching Jobber tax group for customer addresses shown on pages of the Jobber CRM (secure.getjobber.com).

## What the extension reads

The extension reads street addresses that are already visible on the Jobber page you have open. It does not read any other page content, and it only runs on secure.getjobber.com.

## Where address data goes

Most lookups are answered entirely inside your browser from a bundled copy of the Ohio Department of Taxation's public rate and boundary data. No address leaves your computer for those lookups.

When an address cannot be resolved locally (for example, a street the state's data does not list), the extension sends the street address to one or more of these services, solely to determine the county:

- The United States Census Bureau geocoder (geocoding.geo.census.gov)
- The FCC Area API (geo.fcc.gov)
- Steambrite's own lookup server (tax.steambrite.us)

These requests contain the address only. No names, phone numbers, emails, or other customer details are sent. The government services are public and operate under their own privacy policies. Steambrite's server does not store lookups beyond standard, short-lived server request logs.

The extension also downloads the public rate data file from GitHub Pages (github.io) or Google Cloud Storage (storage.googleapis.com). No user data is sent in those downloads.

## What is stored

Settings, the cached rate data, and recent lookup results are stored locally in your browser using Chrome's extension storage. They are never transmitted to Steambrite or anyone else, and they are removed when you uninstall the extension.

## What the extension does not do

- No analytics, tracking, or advertising
- No selling or sharing of data with third parties
- No use of data for any purpose other than suggesting a tax rate
- No collection of browsing history, keystrokes, credentials, or payment information

## Contact

Questions about this policy: jeffrey@steambrite.us
