# Stage 1: Build React PWA Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Fastify Backend
FROM node:20-alpine AS backend-builder
WORKDIR /app/backend
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
RUN npm run build

# Stage 3: Production Runner
FROM node:20-alpine AS runner
WORKDIR /app

# Install runtime dependencies: ffmpeg, yt-dlp, python3, curl, libstdc++ for SQLite
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip \
    curl \
    libstdc++ \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Install latest yt-dlp directly
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

COPY backend/package*.json ./
RUN apk add --no-cache python3 make g++ \
    && npm install --omit=dev \
    && apk del python3 make g++

# Copy compiled backend
COPY --from=backend-builder /app/backend/dist ./dist

# Copy compiled frontend PWA assets into public directory
COPY --from=frontend-builder /app/frontend/dist ./public

# Ensure storage directories exist
RUN mkdir -p /app/data /app/music

EXPOSE 5050

CMD ["node", "dist/index.js"]
