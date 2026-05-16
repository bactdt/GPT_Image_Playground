# Krill Async Backend Contract

This frontend uses the async Krill adapter only for `providerName === "krill"` when the task has input images or an edit mask.

The adapter creates a background job instead of waiting on a long `/v1/images/edits` request. This avoids Cloudflare 524 timeouts for slow image edits.

## Base URL

Use the same provider `baseUrl` configured in the app:

```text
https://blue-cherry-a344.bactdt.workers.dev/krill
```

For async mode, the frontend calls:

```text
POST {baseUrl}/v1/krill/jobs
GET  {baseUrl}/v1/krill/jobs/{jobId}
```

The app still uses regular Images API paths for non-edit text-to-image:

```text
POST {baseUrl}/v1/images/generations
```

## Create Job

```text
POST /v1/krill/jobs
Authorization: Bearer <api key>
Content-Type: multipart/form-data; boundary=<browser-generated>
```

The backend must accept multipart form data. The frontend does not set `Content-Type` manually.

Fields:

```text
model=cn-gpt-image-2
prompt=<user prompt>
image[]=<file>
mask=<file>              optional
size=1024x1024           when UI size is auto
quality=medium
output_format=png
moderation=low
```

The create endpoint should return quickly:

```json
{
  "jobId": "job_abc123",
  "status": "queued"
}
```

It may also return a completed result immediately:

```json
{
  "jobId": "job_abc123",
  "status": "succeeded",
  "result": {
    "data": [
      { "b64_json": "..." }
    ]
  }
}
```

## Poll Job

```text
GET /v1/krill/jobs/{jobId}
Authorization: Bearer <api key>
```

Pending response:

```json
{
  "jobId": "job_abc123",
  "status": "running"
}
```

Success response:

```json
{
  "jobId": "job_abc123",
  "status": "succeeded",
  "result": {
    "data": [
      { "b64_json": "..." }
    ]
  }
}
```

Failure response:

```json
{
  "jobId": "job_abc123",
  "status": "failed",
  "error": {
    "message": "upstream error"
  }
}
```

Accepted status values:

```text
queued
running
succeeded
failed
canceled
```

The frontend also treats `completed`, `done`, and `success` as `succeeded`, and `error` as `failed`.

## Result Payload

The `result` field should be compatible with the Images API response shape:

```json
{
  "data": [
    { "b64_json": "..." }
  ]
}
```

These shapes are also accepted by the existing parser:

```json
{ "data": [{ "url": "https://..." }] }
```

```json
{ "data": [{ "image_url": "data:image/png;base64,..." }] }
```

## Backend Rules

- Keep the create request multipart. Do not require JSON image payloads.
- Do not convert files into `image_url` data URLs on the frontend.
- Store uploaded files or stream them to a background worker.
- Call Krill upstream from the backend with:

```text
POST /v1/images/edits
multipart/form-data
```

- Do not call `/v1/responses` for `cn-gpt-image-2`.
- Do not require `stream=true`.
- Enable CORS for the GitHub Pages origin, for example:

```text
Access-Control-Allow-Origin: https://bactdt.github.io
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Allow-Methods: GET, POST, OPTIONS
```
