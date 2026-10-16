#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project=${GCP_PROJECT:-example-gcp-project}
region=${GCP_REGION:-us-central1}
registry=${GCP_REGISTRY:-us-central1-docker.pkg.dev/example-gcp-project/jarvis}
service=${CLOUD_RUN_SERVICE:-web}
api_url=${EXPO_PUBLIC_API_URL:?Set EXPO_PUBLIC_API_URL to the browser-reachable Jarvis v1 API}
google_client_id=${EXPO_PUBLIC_GOOGLE_CLIENT_ID:?Set EXPO_PUBLIC_GOOGLE_CLIENT_ID to the Web OAuth client ID}
apk_url=${EXPO_PUBLIC_APK_DOWNLOAD_URL:-https://storage.googleapis.com/example-jarvis-apks/releases/latest.apk}
tag=${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}
image="$registry/$service:$tag"

if [[ "${BUILD_REMOTE:-true}" == "true" ]]; then
  gcloud builds submit "$repo_root/apps/mobile" \
    --config "$repo_root/deploy/cloud-run/mobile-web.cloudbuild.yaml" \
    --project "$project" \
    --substitutions "_IMAGE=$image,_API_URL=$api_url,_GOOGLE_CLIENT_ID=$google_client_id,_APK_URL=$apk_url"
else
  gcloud auth configure-docker "${region}-docker.pkg.dev" --quiet
  docker build \
    --platform linux/amd64 \
    --build-arg "EXPO_PUBLIC_API_URL=$api_url" \
    --build-arg "EXPO_PUBLIC_GOOGLE_CLIENT_ID=$google_client_id" \
    --build-arg "EXPO_PUBLIC_APK_DOWNLOAD_URL=$apk_url" \
    -t "$image" \
    "$repo_root/apps/mobile"
  docker push "$image"
fi

deploy_args=(
  run deploy "$service"
  --image "$image"
  --project "$project"
  --region "$region"
  --set-env-vars "EXPO_PUBLIC_API_URL=$api_url,EXPO_PUBLIC_GOOGLE_CLIENT_ID=$google_client_id,EXPO_PUBLIC_APK_DOWNLOAD_URL=$apk_url"
  --quiet
)
if [[ "${NO_TRAFFIC:-false}" == "true" ]]; then
  deploy_args+=(--no-traffic --tag jarvis-migration)
fi
gcloud "${deploy_args[@]}"

if [[ "${NO_TRAFFIC:-false}" != "true" ]]; then
  gcloud run services update-traffic "$service" \
    --project "$project" \
    --region "$region" \
    --to-latest \
    --quiet
fi
