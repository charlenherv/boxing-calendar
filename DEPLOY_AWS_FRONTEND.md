# (Optional) Front the calendar with your own domain (AWS)

The GCP setup in `DEPLOY_GCP.md` gives you a working subscribe URL already:
`https://storage.googleapis.com/BUCKET/boxing.ics`. This step is purely
cosmetic/privacy — it puts your own domain in front of that URL (e.g.
`https://boxing.yourdomain.com/calendar`) instead of exposing the raw GCS
bucket name. Skip it if you don't care.

Four pieces, all in AWS:

| Piece | AWS service |
|-------|-------------|
| HTTPS cert for your subdomain | ACM (must be in `us-east-1`) |
| Fetches the real `.ics` and re-serves it | Lambda (Function URL) |
| Public edge, custom domain, caching | CloudFront |
| DNS | Route 53 |

Cost is effectively $0/month for personal traffic: Lambda's free tier
(1M requests/month) never gets touched, CloudFront's per-request/per-GB
cost is fractions of a cent at this volume, and Route 53 only bills if you
don't already have a hosted zone for your domain (you likely do).

---

## 0. Variables

```bash
export DOMAIN="boxing.yourdomain.com"
export HOSTED_ZONE_ID="Z..."              # aws route53 list-hosted-zones
export ACCOUNT_ID="..."                    # aws sts get-caller-identity
export GCS_ICS_URL="https://storage.googleapis.com/BUCKET/boxing.ics"
```

## 1. ACM certificate (DNS-validated, `us-east-1`)

```bash
aws acm request-certificate \
  --domain-name "$DOMAIN" \
  --validation-method DNS \
  --region us-east-1
```

Grab the validation CNAME it wants and create it in Route 53:

```bash
aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
  --query "Certificate.DomainValidationOptions"
```

Create that `Name`/`Value` as a CNAME record in your hosted zone, then wait:

```bash
aws acm wait certificate-validated --certificate-arn "$CERT_ARN" --region us-east-1
```

## 2. Lambda proxy

`index.js` in this folder reads `GCS_URL` and only answers on one path
(`/calendar` by default). Zip it, create an execution role, deploy, and
expose a public Function URL:

```bash
zip function.zip index.js

aws iam create-role --role-name boxing-calendar-proxy-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'

aws iam attach-role-policy --role-name boxing-calendar-proxy-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws lambda create-function \
  --function-name boxing-calendar-proxy \
  --runtime nodejs20.x \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/boxing-calendar-proxy-role" \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --timeout 10 --memory-size 128 \
  --region us-east-1

aws lambda update-function-configuration \
  --function-name boxing-calendar-proxy \
  --environment "Variables={GCS_URL=$GCS_ICS_URL}" \
  --region us-east-1

aws lambda create-function-url-config \
  --function-name boxing-calendar-proxy \
  --auth-type NONE \
  --region us-east-1

# AuthType NONE still needs an explicit public-invoke permission:
aws lambda add-permission \
  --function-name boxing-calendar-proxy \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE \
  --region us-east-1
```

## 3. CloudFront distribution

Use the Lambda Function URL's hostname (strip `https://`) as a custom
origin, attach the cert, and use the managed **CachingOptimized** policy so
CloudFront respects the `Cache-Control: max-age=3600` header the GCS object
already has (see `ics.js` / `scrape.js`'s upload metadata). That means
**no scheduled invalidations are needed** — CloudFront just re-checks the
origin once an hour on its own, which is already far more often than the
weekly Cloud Scheduler run changes anything.

Build a distribution config (see this repo's own deploy for a full example)
with:
- `Origins`: your Lambda Function URL domain, `OriginProtocolPolicy: https-only`
- `DefaultCacheBehavior.CachePolicyId`: the managed CachingOptimized policy
  (`aws cloudfront list-cache-policies --type managed` to look up the id)
- `Aliases`: `["$DOMAIN"]`
- `ViewerCertificate.ACMCertificateArn`: the cert from step 1

```bash
aws cloudfront create-distribution --distribution-config file://cloudfront-config.json
```

Wait for it to finish deploying (5-20 min):

```bash
aws cloudfront wait distribution-deployed --id "$DISTRIBUTION_ID"
```

## 4. Route 53 alias record

Point your subdomain at the distribution (CloudFront's alias hosted zone id
is always `Z2FDTNDATAQYW2`):

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch '{
    "Changes": [
      {"Action":"UPSERT","ResourceRecordSet":{"Name":"'"$DOMAIN"'","Type":"A","AliasTarget":{"HostedZoneId":"Z2FDTNDATAQYW2","DNSName":"'"$DISTRIBUTION_DOMAIN"'","EvaluateTargetHealth":false}}},
      {"Action":"UPSERT","ResourceRecordSet":{"Name":"'"$DOMAIN"'","Type":"AAAA","AliasTarget":{"HostedZoneId":"Z2FDTNDATAQYW2","DNSName":"'"$DISTRIBUTION_DOMAIN"'","EvaluateTargetHealth":false}}}
    ]
  }'
```

## 5. Subscribe

```
https://boxing.yourdomain.com/calendar
```

## Updating the Lambda later

If you ever add more paths under the same domain, don't spin up a second
CloudFront distribution — a custom domain can only be attached to one
distribution at a time. Instead add more cache behaviors (path patterns) to
this same distribution, each pointing at whatever origin you need.
