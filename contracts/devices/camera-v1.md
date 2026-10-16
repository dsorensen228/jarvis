# Camera device contract v1

The camera is a separately deployed Raspberry Pi service. Its callback endpoints are LAN-facing;
the Jarvis API is the only normal caller.

## Camera callback

- `GET /health/live` is unauthenticated and returns process liveness.
- `GET /health/ready` is unauthenticated and returns `503` until a complete JPEG exists.
- `GET /v1/camera/snapshot` requires `Authorization: Bearer <callback token>` and returns one JPEG.
- `GET /v1/camera/stream` requires the same token and returns bounded-rate MJPEG with boundary
  `frame`.

Snapshot responses use `Cache-Control: no-store` and include `X-Capture-Timestamp`,
`X-Frame-Sequence`, `X-Frame-Width`, and `X-Frame-Height`.

Readiness includes the latest frame sequence, fatal/degraded detector state, last thresholded person
score, and current debounced person-presence state for operational diagnosis.

## API registration and presence

An authenticated camera calls `PUT /v1/devices/{device_id}/registration`. The first request creates
the stable camera ID and later requests update it. `callback_token` is encrypted in the credential
vault and is never returned by device APIs. The camera posts health data to
`POST /v1/devices/{device_id}/heartbeat` every 30 seconds.

When configured with a `.local` callback URL, the camera resolves it to its current LAN IPv4 before
registration. The containerized API therefore does not depend on the Jetson host's mDNS resolver;
the camera refreshes the registered address whenever its service starts.

## Person events

`POST /v1/devices/{device_id}/camera/events` is authenticated multipart form data:

- `event_id`: device-generated UUID, reused across retries;
- `event_type`: currently `person_detected`;
- `captured_at`: UTC ISO-8601 timestamp;
- `confidence`: optional floating-point IMX500 confidence;
- `frame`: optional JPEG, at most 10 MiB.

The API hashes `(device_id, event_id)` into the persistence ID, making retries idempotent.
For the first `person_detected` event only, the API selects connected voice devices whose metadata
has `doorbell_alerts_enabled: true`, synthesizes the fixed alert with Kokoro, and sends it over each
device's persistent voice WebSocket. The same first event also pushes an Expo notification to every
registered Android Expo push token for the camera owner (`channelId` `camera-person`, data
`type=person_detected`). A camera may provide a fixed `person_alert_text` in its registration
metadata; otherwise the API derives a concise message from the configured room. The event records
announcement status, mobile push status, exact text, and targets. The alert does not invoke the LLM,
and retrying the same event never repeats voice or push delivery.

## Browser/mobile stream access

Authenticated clients create a 15-minute session with
`POST /v1/devices/{device_id}/camera/stream-session`, then use the returned opaque token on
`GET /v1/devices/{device_id}/camera/stream?camera_token=...`. The API forwards the encrypted
callback credential to the Pi; the credential never enters the browser.
