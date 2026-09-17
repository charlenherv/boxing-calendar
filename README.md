# Ring Boxing Calendar

A subscribable ("streaming") iCal feed of upcoming boxing events, built from
**The Ring Magazine**'s own schedule API. A weekly cron job re-fetches the
schedule and writes a `.ics` file to a public URL that your calendar app
subscribes to.

## How it works

```
Cloud Scheduler (weekly)
        |
        v
  Cloud Run Job  --->  fetch ringmagazine.com events API (JSON)
        |                    |
        |                    v
        |              build boxing.ics
        v                    |
   upload to  <--------------+
 Cloud Storage bucket  --->  https://storage.googleapis.com/BUCKET/boxing.ics
                                        ^
                                        |
                          your calendar app subscribes here
```

No headless browser. Ring's events page loads its schedule from a JSON API, so
we call that endpoint directly and parse it. That keeps the container tiny and
the whole thing very cheap to run.

## Files

| File | What it does |
|------|--------------|
| `scrape.js` | Entry point: fetch the API (with pagination), build the `.ics`, upload to GCS. |
| `normalize.js` | Turn Ring's API JSON into clean `{ uid, matchup, start }` events. |
| `ics.js` | Dependency-free RFC 5545 calendar builder (stable UIDs, refresh hint). |
| `test.js` + `fixtures/` | Offline tests against Ring's real API shape. |
| `Dockerfile` | Tiny `node:20-slim` image for the Cloud Run Job. |
| `DEPLOY_GCP.md` | Step-by-step GCP deploy. |
| `DEPLOY_AWS_FRONTEND.md` + `aws-frontend/` | Optional: front the feed with your own domain instead of a raw GCS URL. |

## Event content

Minimal, by design: each event is the **main-event matchup** (full fighter
names, e.g. `Isaac Cruz vs Nestor Bravo`) at the **main-event start time**.
Nothing else in the body. To add venue, broadcaster, or the full card later,
extend `normalizeEvent` in `normalize.js` and `buildEvent` in `ics.js`.

## Run it locally

```bash
npm install
npm test          # runs the offline parser + iCal tests

# Generate the .ics locally (writes ./boxing.ics, no upload):
node scrape.js
```

If your network can reach `ringmagazine.com`, `node scrape.js` prints the
events it found and writes `boxing.ics`. Open that file to confirm it looks
right before deploying.

## Deploy

See `DEPLOY_GCP.md`. Optionally, `DEPLOY_AWS_FRONTEND.md` puts your own
domain in front of the feed (e.g. `boxing.yourdomain.com/calendar`) instead
of a raw `storage.googleapis.com` URL.

## The "even lighter" note

There is no lighter version to graduate to — this already is the direct API
call. If Ring ever changes the endpoint or the JSON field names, update
`API_BASE` (env var) and the field logic in `normalize.js`. The tests in
`test.js` will tell you fast if the shape drifts.
