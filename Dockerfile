# Multi-stage build for Pluto Backend API
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install all dependencies (including dev dependencies for potential build steps)
RUN npm ci --silent && npm cache clean --force

# Production stage for Backend API
FROM node:18-alpine AS production

# Install system dependencies for video processing and build tools
RUN apk add --no-cache \
    dumb-init \
    ffmpeg \
    ffmpeg-dev \
    build-base \
    python3 \
    make \
    g++ \
    curl

# Create app user for security
RUN addgroup -g 1001 -S nodejs && adduser -S pluto-backend -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production --silent && npm cache clean --force

# Copy application code with proper ownership
COPY --chown=pluto-backend:nodejs . .

# Create directories with proper permissions for media processing
RUN mkdir -p uploads && \
    mkdir -p uploads/temp && \
    mkdir -p uploads/videos && \
    mkdir -p uploads/thumbnails && \
    mkdir -p logs && \
    chown -R pluto-backend:nodejs uploads && \
    chown -R pluto-backend:nodejs logs

# Switch to non-root user
USER pluto-backend

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "server.js"]
