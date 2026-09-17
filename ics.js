'use strict';

/**
 * ics.js
 * Pure, dependency-free iCalendar (RFC 5545) builder for a *subscribed*
 * ("streaming") calendar. No external deps so the container stays tiny.
 *
 * Design choices that matter for a subscription feed:
 *  - Each VEVENT carries a stable UID (from normalize.js) so when the feed is
 *    re-fetched, calendar apps UPDATE the existing event instead of duplicating.
 *  - REFRESH-INTERVAL / X-PUBLISHED-TTL hint how often clients should re-pull.
 *  - Lines are folded at 75 octets per the spec (some clients are strict).
 */

function pad(n) {
  return String(n).padStart(2, '0');
}

// UTC timestamp: 20260919T170000Z
function toUtcStamp(date) {
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  );
}

// Local date only: 20260919
function toDateStamp(date) {
  return (
    date.getUTCFullYear() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate())
  );
}

// Escape text per RFC 5545 (commas, semicolons, backslashes, newlines).
function esc(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold long lines at 75 octets; continuation lines start with a space.
function fold(line) {
  const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
  if (bytesOf(line) <= 75) return line;
  let out = '';
  let cur = '';
  for (const ch of line) {
    if (bytesOf(cur + ch) > 75) {
      out += (out ? '\r\n ' : '') + cur;
      cur = ch;
    } else {
      cur += ch;
    }
  }
  out += (out ? '\r\n ' : '') + cur;
  return out;
}

function buildEvent(ev, dtstamp) {
  const lines = ['BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${dtstamp}`];

  if (ev.allDay) {
    const day = toDateStamp(ev.start);
    const next = new Date(ev.start.getTime() + 24 * 3600 * 1000);
    lines.push(`DTSTART;VALUE=DATE:${day}`);
    lines.push(`DTEND;VALUE=DATE:${toDateStamp(next)}`);
  } else {
    lines.push(`DTSTART:${toUtcStamp(ev.start)}`);
    // Fights run a few hours; 3h keeps the block reasonable.
    const end = new Date(ev.start.getTime() + 3 * 3600 * 1000);
    lines.push(`DTEND:${toUtcStamp(end)}`);
  }

  lines.push(`SUMMARY:${esc(ev.matchup)}`);
  lines.push('STATUS:CONFIRMED');
  lines.push('TRANSP:TRANSPARENT');
  lines.push('END:VEVENT');
  return lines;
}

/**
 * buildCalendar(events, opts) -> string of full .ics content (CRLF line endings).
 */
function buildCalendar(events, opts = {}) {
  const {
    name = 'Boxing Schedule',
    description = 'Upcoming boxing schedule, scraped from The Ring Magazine.',
    ttlHours = 168, // weekly
    prodId = '-//ring-boxing-calendar//EN',
  } = opts;

  const dtstamp = toUtcStamp(new Date());

  let lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    `X-WR-CALDESC:${esc(description)}`,
    `X-PUBLISHED-TTL:PT${ttlHours}H`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${ttlHours}H`,
  ];

  for (const ev of events) lines = lines.concat(buildEvent(ev, dtstamp));

  lines.push('END:VCALENDAR');

  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildCalendar, toUtcStamp, toDateStamp, esc, fold };
