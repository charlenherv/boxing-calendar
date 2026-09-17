'use strict';

/**
 * test.js — offline tests for the parsing + iCal logic against Ring's real
 * API shape (see fixtures/ring-sample.json). The live fetch needs internet,
 * but everything that turns the API JSON into a valid .ics is pure and tested
 * here. Run: `npm test`.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseRingPage, finalize } = require('./normalize');
const { buildCalendar } = require('./ics');

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
};

const page = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'ring-sample.json'), 'utf8')
);

// keepPastDays huge so the test is time-independent.
const events = finalize(parseRingPage(page), { keepPastDays: 1e6 });

// The fixture has 4 events; all 4 are parseable (the last falls back to slogan).
ok(events.length === 4, `expected 4 events, got ${events.length}`);

const byMatchup = Object.fromEntries(events.map((e) => [e.matchup, e]));

// Main-event fighter names become the title.
ok(byMatchup['Isaac Cruz vs Nestor Bravo'], 'title from main-event fighters');

// Uses the MAIN EVENT start time (01:30Z), not the card start (21:00Z).
ok(
  byMatchup['Isaac Cruz vs Nestor Bravo'].start.toISOString() ===
    '2026-09-20T01:30:00.000Z',
  'uses main-event ring-walk time'
);

// When no fight is flagged main, falls back to the first fight's fighters.
ok(byMatchup['First Fighter vs Second Fighter'], 'falls back to first fight');

// When there are no fights at all, falls back to eventSlogan.
ok(byMatchup['Slogan Only Event'], 'falls back to eventSlogan');

// UID is the event's own id -> stable across renames/re-fetches.
ok(
  byMatchup['Isaac Cruz vs Nestor Bravo'].uid ===
    '4KcUnNvGRpDnb0ONBP3SkH@ring-boxing-calendar',
  'UID is the event id'
);

// Sorted ascending.
ok(
  events.every((e, i) => i === 0 || events[i - 1].start <= e.start),
  'events sorted by start'
);

// ---- iCal structural checks.
const ics = buildCalendar(events);
ok(ics.startsWith('BEGIN:VCALENDAR\r\n'), 'starts with VCALENDAR');
ok(ics.trimEnd().endsWith('END:VCALENDAR'), 'ends with VCALENDAR');
ok((ics.match(/BEGIN:VEVENT/g) || []).length === 4, 'one VEVENT per event');
ok(ics.includes('REFRESH-INTERVAL;VALUE=DURATION:PT168H'), 'weekly refresh hint');
ok(ics.includes('DTSTART:20260920T013000Z'), 'timed main event in UTC');
ok(
  /UID:4KcUnNvGRpDnb0ONBP3SkH@ring-boxing-calendar/.test(ics),
  'stable event-id UID present'
);

// ---- de-dupe check: feeding the same page twice yields no duplicates.
const doubled = finalize(parseRingPage(page).concat(parseRingPage(page)), {
  keepPastDays: 1e6,
});
ok(doubled.length === events.length, 'duplicate events collapse by UID');

// ---- past-event filtering actually drops old events.
const onlyFuture = finalize(parseRingPage(page), { keepPastDays: 1 });
ok(
  onlyFuture.every((e) => e.start.getTime() >= Date.now() - 2 * 86400000),
  'past events filtered out'
);

console.log(`\nAll ${passed} assertions passed.`);
