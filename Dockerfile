# Multi-stage build for minimal image size

# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder

WORKDIR /app/client

# Copy frontend package files
COPY client/package*.json ./

# Install ALL frontend dependencies (including dev, needed for build)
RUN npm install

# The perceptual-hash module, which lives outside client/ on purpose.
#
# It is the one piece of code the browser and the server must run *identically*
# — a reference hash and a capture hash are only comparable if the same
# arithmetic produced both — so there is exactly one copy of it, at
# src/shared/cardHash.js. The client imports it across the boundary, which is
# safe because the browser resolves imports at build time; the server imports it
# at runtime, which is why it lives on the server's side.
#
# That means this stage needs it too, and needs it at /app/src/shared so the
# relative import from /app/client resolves. Copied before the client sources
# below because it changes far less often, so it lands in an earlier cache layer.
COPY src/shared /app/src/shared

# Copy frontend source
COPY client/ ./

# Build frontend
RUN npm run build

# Stage 2: Build backend dependencies
#
# Node 22 rather than 20, and the version is load-bearing rather than
# housekeeping: better-sqlite3 publishes prebuilt binaries per Node ABI, and
# from 12.x it stopped publishing them for Node 20 (ABI 115) even though its
# `engines` field still claims 20.x. On Alpine — musl, so it needs the
# `linuxmusl` builds specifically — that left npm falling back to compiling
# from source, which this image has no toolchain for. 12.11.1 publishes
# linuxmusl prebuilds for ABIs 127, 137, 141 and 147; Node 22 is 127, for both
# amd64 and arm64.
FROM node:22-alpine AS backend-builder

WORKDIR /app

# The toolchain is insurance, not the plan. With a matching prebuild published
# none of it is used and the install is a download. Without one — a future Node
# bump landing ahead of the prebuilds again — this turns a red build into a
# slow one, which is the difference between a deploy that waits and a deploy
# that cannot happen. It lives in a builder stage, so none of it reaches the
# final image.
RUN apk add --no-cache python3 make g++

# Copy backend package files
COPY package*.json ./

# Install backend dependencies
RUN npm install --omit=dev

# Stage 3: Final production image
FROM node:22-alpine

# Install bzip2 for MTGJSON decompression
RUN apk add --no-cache bzip2

WORKDIR /app

# Copy backend dependencies from builder
COPY --from=backend-builder /app/node_modules ./node_modules

# Copy backend source
COPY src ./src
COPY scripts ./scripts
COPY package*.json ./

# Copy built frontend from frontend-builder
COPY --from=frontend-builder /app/client/dist ./client/dist

# Copy favicon assets
COPY assets/favicon.ico ./client/dist/favicon.ico
COPY assets/favicon-16x16.png ./client/dist/favicon-16x16.png
COPY assets/favicon-32x32.png ./client/dist/favicon-32x32.png
COPY assets/apple-touch-icon.png ./client/dist/apple-touch-icon.png
COPY assets/android-chrome-192x192.png ./client/dist/android-chrome-192x192.png
COPY assets/android-chrome-512x512.png ./client/dist/android-chrome-512x512.png

# Create data directory
RUN mkdir -p /app/data

# The packed perceptual hashes. Deliberately NOT under /app/data: that path is
# the bind-mounted volume on a real deployment, and anything the image puts
# there is hidden the moment the volume is mounted over it.
COPY data/card-hashes.bin /app/card-hashes.bin

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/deck-lotus.db
ENV CARD_HASH_PATH=/app/card-hashes.bin

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "src/server.js"]
