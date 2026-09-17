'use strict';

/**
 * scrape.js — main entry point (runs in the Cloud Run Job).
 *
 * No browser. We call Ring Magazine's own JSON API directly (the endpoint the
 * events page fetches under the hood), page through it, build a subscribable
 * .ics, and upload it to Cloud Storage.
 *
 * Env vars:
 *   API_BASE     default https://www.ringmagazine.com/api/cached/v1/content/search/events/upcoming
 *   PAGE_LIMIT   items per request, default 50
 *   MAX_PAGES    safety cap on pagination, default 6
 *   BUCKET       GCS bucket name; if unset we only write locally
 *   OBJECT       object/key name, default boxing.ics
 *   OUT          local output path, default ./boxing.ics
 */

const fs = require('fs');
const path = require('path');
const { parseRingPage, finalize } = require('./normalize');
const { buildCalendar } = require('./ics');

const API_BASE =
  process.env.API_BASE ||
  'https://www.ringmagazine.com/api/cached/v1/content/search/events/upcoming';
const PAGE_LIMIT = Number(process.env.PAGE_LIMIT || 50);
const MAX_PAGES = Number(process.env.MAX_PAGES || 6);
const BUCKET = process.env.BUCKET || '';
const OBJECT = process.env.OBJECT || 'boxing.ics';
const OUT = process.env.OUT || path.join(__dirname, 'boxing.ics');

function buildUrl(cursor) {
  const u = new URL(API_BASE);
  u.searchParams.set('limit', String(PAGE_LIMIT));
  u.searchParams.set('language', 'en');
  u.searchParams.set('_ttl', '60');
  if (cursor) u.searchParams.set('cursor', cursor);
  return u.toString();
}

async function fetchAllEvents() {
  const all = [];
  let cursor = null;
  let seenCursors = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = buildUrl(cursor);
    console.log(`Fetching page ${page + 1}: ${url}`);

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        // A normal-looking UA + Referer; the endpoint is same-origin on the site.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) Version/17 Safari/605.1.15',
        Referer: 'https://www.ringmagazine.com/events',
      },
    });

    if (!res.ok) {
      throw new Error(`API returned HTTP ${res.status} for ${url}`);
    }

    const body = await res.json();
    const events = parseRingPage(body);
    all.push(...events);

    const pg = (body && body.pagination) || {};
    cursor = pg.nextCursor || null;
    if (!pg.hasNextPage || !cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
  }

  return finalize(all, { keepPastDays: 1 });
}

async function uploadToGcs(localPath) {
  const { Storage } = require('@google-cloud/storage');
  const storage = new Storage();
  await storage.bucket(BUCKET).upload(localPath, {
    destination: OBJECT,
    metadata: {
      contentType: 'text/calendar; charset=utf-8',
      cacheControl: 'public, max-age=3600',
    },
  });
  console.log(`Uploaded to gs://${BUCKET}/${OBJECT}`);
}

async function main() {
  const events = await fetchAllEvents();
  console.log(`Parsed ${events.length} upcoming event(s).`);
  for (const e of events) {
    console.log(`  ${e.start.toISOString().slice(0, 16)}Z  ${e.matchup}`);
  }

  const ics = buildCalendar(events);
  fs.writeFileSync(OUT, ics);
  console.log(`Wrote ${OUT} (${ics.length} bytes).`);

  if (BUCKET) {
    await uploadToGcs(OUT);
  } else {
    console.log('BUCKET not set — skipping upload (local run).');
  }

  // Make an empty result a visible failure in Cloud Run logs.
  if (!events.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
