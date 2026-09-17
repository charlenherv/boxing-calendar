'use strict';

/**
 * Lambda behind CloudFront: proxies the public GCS .ics so it can be served
 * from a custom domain (e.g. boxing.yourdomain.com/calendar) instead of a
 * raw storage.googleapis.com URL.
 *
 * Env vars:
 *   GCS_URL   full URL to the .ics object, e.g.
 *             https://storage.googleapis.com/<bucket>/boxing.ics
 *   PATH      the single path this Lambda serves, default /calendar
 */

const GCS_URL = process.env.GCS_URL;
const SERVE_PATH = process.env.PATH_OVERRIDE || '/calendar';

exports.handler = async (event) => {
  const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';

  if (path !== SERVE_PATH) {
    return { statusCode: 404, body: 'Not found' };
  }

  const res = await fetch(GCS_URL);
  if (!res.ok) {
    return { statusCode: 502, body: `Upstream error: ${res.status}` };
  }

  const body = await res.text();
  const cacheControl = res.headers.get('cache-control') || 'public, max-age=3600';

  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': cacheControl,
    },
    body,
  };
};
