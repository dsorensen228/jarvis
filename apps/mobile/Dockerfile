# Build Expo web app
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .

ARG EXPO_PUBLIC_API_URL=http://localhost:8000
ARG EXPO_PUBLIC_GOOGLE_CLIENT_ID=
ARG EXPO_PUBLIC_APK_DOWNLOAD_URL=
# Create .env (Expo loads from project root)
RUN test -n "$EXPO_PUBLIC_GOOGLE_CLIENT_ID" || (echo "ERROR: EXPO_PUBLIC_GOOGLE_CLIENT_ID is empty" && exit 1)
RUN printf 'EXPO_PUBLIC_API_URL=%s\nEXPO_PUBLIC_GOOGLE_CLIENT_ID=%s\nEXPO_PUBLIC_APK_DOWNLOAD_URL=%s\n' \
    "$EXPO_PUBLIC_API_URL" "$EXPO_PUBLIC_GOOGLE_CLIENT_ID" "$EXPO_PUBLIC_APK_DOWNLOAD_URL" > .env
# Explicitly pass vars to expo (backup for .env loading)
RUN env EXPO_PUBLIC_API_URL="$EXPO_PUBLIC_API_URL" \
    EXPO_PUBLIC_GOOGLE_CLIENT_ID="$EXPO_PUBLIC_GOOGLE_CLIENT_ID" \
    EXPO_PUBLIC_APK_DOWNLOAD_URL="$EXPO_PUBLIC_APK_DOWNLOAD_URL" npx expo export -p web

# Serve static build (Cloud Run expects port 8080)
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker-entrypoint-web.sh /docker-entrypoint-web.sh
RUN chmod +x /docker-entrypoint-web.sh
RUN printf '%s\n' 'server { listen 8080; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint-web.sh"]
