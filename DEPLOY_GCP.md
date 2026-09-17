# Deploy on Google Cloud (learning walkthrough)

This puts the scraper on a weekly cron in GCP and serves the calendar at a
stable public URL. Four services do the work:

| Piece | GCP service | AWS equivalent |
|-------|-------------|----------------|
| Cron (weekly) | Cloud Scheduler | EventBridge Scheduler |
| Runs the scraper | Cloud Run Job | Lambda (or Fargate) |
| Holds the `.ics` | Cloud Storage bucket | S3 |
| Permissions glue | IAM service accounts | IAM roles |

Total cost for something this small is effectively $0 (comfortably inside the
free tiers).

---

## 0. One-time setup

Install the `gcloud` CLI and sign in:

```bash
gcloud auth login
gcloud components update
```

Pick names once and paste this block into your shell. Reuse the same shell for
the rest of the guide (these variables need to stay set) — or copy
`deploy-env.sh.example` to `deploy-env.sh` (gitignored), fill in your real
`PROJECT_ID`, and `source deploy-env.sh` instead.

```bash
export PROJECT_ID="your-project-id"       # create one in the console if needed
export REGION="us-central1"
export BUCKET="ringcal-$PROJECT_ID"       # bucket names are globally unique
export JOB="ring-boxing-calendar"
export OBJECT="boxing.ics"

gcloud config set project "$PROJECT_ID"
```

Enable the APIs you'll use:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com
```

---

## 1. Create the bucket that serves the calendar

```bash
gcloud storage buckets create "gs://$BUCKET" \
  --location="$REGION" \
  --uniform-bucket-level-access

# Make objects in it publicly readable (a subscribed calendar needs a public URL).
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="allUsers" \
  --role="roles/storage.objectViewer"
```

If that last command is rejected, your org has "public access prevention"
turned on. Two options: ask an admin to allow it on this one bucket, or serve
the file through a tiny Cloud Run service instead (see Troubleshooting).

The public URL of your calendar will be:

```
https://storage.googleapis.com/BUCKET/boxing.ics
```

---

## 2. Deploy the scraper as a Cloud Run Job

`--source .` hands your folder to Cloud Build, which sees the `Dockerfile` and
builds the image for you. No manual registry steps.

```bash
gcloud run jobs deploy "$JOB" \
  --source . \
  --region="$REGION" \
  --memory=512Mi \
  --cpu=1 \
  --task-timeout=120s \
  --max-retries=1 \
  --set-env-vars="BUCKET=$BUCKET,OBJECT=$OBJECT"
```

512Mi is plenty: there's no browser, just a JSON fetch and a small file write.

### Let the job write to the bucket

The job runs as your project's default compute service account. Grant it write
access to just this bucket:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$RUN_SA" \
  --role="roles/storage.objectAdmin"
```

### Run it once by hand to confirm

```bash
gcloud run jobs execute "$JOB" --region="$REGION" --wait
```

Then check the logs and the file:

```bash
gcloud run jobs executions list --job="$JOB" --region="$REGION"
gcloud storage cat "gs://$BUCKET/$OBJECT" | head -30
```

The logs list every event it parsed, so you can eyeball that the schedule
looks right.

---

## 3. Schedule it weekly

Cloud Scheduler will call the Run Jobs API on a cron. It needs its own service
account allowed to invoke the job.

```bash
gcloud iam service-accounts create scheduler-invoker \
  --display-name="Invokes the boxing calendar job"

SCHED_SA="scheduler-invoker@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud run jobs add-iam-policy-binding "$JOB" \
  --region="$REGION" \
  --member="serviceAccount:$SCHED_SA" \
  --role="roles/run.invoker"
```

Create the schedule. This example runs every Monday at 08:00 US Central. Adjust
the cron and timezone to taste.

```bash
gcloud scheduler jobs create http ring-boxing-weekly \
  --location="$REGION" \
  --schedule="0 8 * * 1" \
  --time-zone="America/Chicago" \
  --uri="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB}:run" \
  --http-method=POST \
  --oauth-service-account-email="$SCHED_SA"
```

Force a run now to prove the schedule wiring works:

```bash
gcloud scheduler jobs run ring-boxing-weekly --location="$REGION"
```

---

## 4. Subscribe

Add this as a subscribed calendar (not an import, so it keeps refreshing):

```
https://storage.googleapis.com/BUCKET/boxing.ics
```

- Apple Calendar: File > New Calendar Subscription, paste the URL.
- Google Calendar: Other calendars > + > From URL.

Google Calendar refreshes subscribed URLs on its own cadence (often slower than
you'd like, sometimes 12 to 24h). Apple lets you pick the refresh interval.

---

## Updating later

Change code, then redeploy the job (same command as step 2) and it rebuilds:

```bash
gcloud run jobs deploy "$JOB" --source . --region="$REGION"
```

The schedule and bucket stay as they are.

---

## Troubleshooting

**"Parsed 0 upcoming events" or an HTTP error in the logs.** Ring changed the
API. Check `API_BASE` and the field logic in `normalize.js` against the live
response, then redeploy. Run `npm test` locally first to confirm your fix.

**Public bucket blocked by org policy.** Serve the file from a small Cloud Run
service instead of a public bucket: the service reads the object with the
service account's own credentials and returns it, so the bucket can stay
private. Ask if you want that variant and I'll add it.

**Nothing on the schedule fires.** Check the Scheduler run result:
`gcloud scheduler jobs describe ring-boxing-weekly --location="$REGION"`. A 403
there means the invoker service account is missing `roles/run.invoker` on the
job (step 3).
