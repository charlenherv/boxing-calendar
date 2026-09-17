'use strict';

/**
 * normalize.js
 * Turn one page of Ring Magazine's events API into clean, minimal calendar
 * events: { uid, matchup, start, allDay }.
 *
 * The API shape (discovered from the live site) looks like:
 *   {
 *     data: [
 *       {
 *         id: "4KcUnNvGRpDnb0ONBP3SkH",
 *         eventSlogan: "Pitbull vs. Bravo",
 *         eventStart: "2026-09-19T21:00:00.000Z",   // card / broadcast start
 *         eventEnd:   "2026-09-20T04:00:00.000Z",
 *         fights: [ { isMainEvent, startTime, fighterA:{name}, fighterB:{name} }, ... ],
 *         eventLocation: { venueName, city, country }
 *       }, ...
 *     ],
 *     pagination: { nextCursor, hasNextPage, limit }
 *   }
 *
 * Choices that matter for the calendar:
 *  - UID  = the event's own stable `id`, so re-fetches update in place.
 *  - Time = the MAIN EVENT ring-walk time when present (that's what a fan wants
 *           on their calendar), otherwise the card's eventStart.
 *  - Title= the main event's "A vs B" full names, falling back to eventSlogan.
 */

function nameOf(f) {
  if (!f) return '';
  if (typeof f === 'string') return f.trim();
  return String(f.name || f.fullName || '').trim();
}

function mainEventOf(ev) {
  const fights = Array.isArray(ev.fights) ? ev.fights : [];
  return fights.find((f) => f && f.isMainEvent) || fights[0] || null;
}

function deriveMatchup(ev) {
  const main = mainEventOf(ev);
  if (main) {
    const a = nameOf(main.fighterA);
    const b = nameOf(main.fighterB);
    if (a && b) return `${a} vs ${b}`;
  }
  // Ring's own branding, e.g. "Pitbull vs. Bravo".
  if (ev.eventSlogan && String(ev.eventSlogan).trim()) {
    return String(ev.eventSlogan).trim();
  }
  return '';
}

function parseWhen(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = new Date(s);
  if (isNaN(d)) return null;
  return { date: d, allDay: dateOnly };
}

function deriveStart(ev) {
  const main = mainEventOf(ev);
  // Prefer the main event's own start time; fall back to the card start.
  return parseWhen((main && main.startTime) || ev.eventStart || ev.eventStartDate);
}

/**
 * Normalize one raw event object. Returns null if it lacks a matchup or a date.
 */
function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const matchup = deriveMatchup(ev);
  const when = deriveStart(ev);
  if (!matchup || !when) return null;

  const uid = (ev.id ? String(ev.id) : matchup.replace(/\s+/g, '-')) +
    '@ring-boxing-calendar';

  return { uid, matchup, start: when.date, allDay: when.allDay };
}

/**
 * Parse a full API response page -> array of normalized events.
 * Accepts either the whole `{ data: [...] }` object or a bare array.
 */
function parseRingPage(page) {
  const list = Array.isArray(page) ? page : (page && page.data) || [];
  const out = [];
  for (const ev of list) {
    const n = normalizeEvent(ev);
    if (n) out.push(n);
  }
  return out;
}

/**
 * De-dupe by UID, drop anything more than `keepPastDays` in the past,
 * and sort ascending by start.
 */
function finalize(events, { keepPastDays = 1 } = {}) {
  const byUid = new Map();
  for (const ev of events) byUid.set(ev.uid, ev);
  const cutoff = Date.now() - keepPastDays * 24 * 3600 * 1000;
  return [...byUid.values()]
    .filter((ev) => ev.start.getTime() >= cutoff)
    .sort((a, b) => a.start - b.start);
}

module.exports = {
  nameOf,
  mainEventOf,
  deriveMatchup,
  deriveStart,
  parseWhen,
  normalizeEvent,
  parseRingPage,
  finalize,
};
