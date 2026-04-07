# ============================================================
# MCQ Exam Portal - Backend Production Dockerfile
# ============================================================
# IMPORTANT: Code execution uses Docker-in-Docker via socket
# mount. On the EC2 host, run with:
#   -v /var/run/docker.sock:/var/run/docker.sock
# and ensure the docker group GID matches on the host.
# ============================================================

# ---------- Stage 1: Dependencies ----------
FROM node:22-alpine AS deps

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---------- Stage 2: Runtime ----------
FROM node:22-alpine AS runtime

# Install docker CLI so the app can run `docker run ...` commands
# for code execution. The actual Docker daemon comes from the host
# via socket bind-mount at runtime.
RUN apk add --no-cache docker-cli

# Install PM2 globally for process management & clustering
RUN npm install -g pm2

# Create non-root user but add to docker group (GID 999 is standard
# for the docker group on Amazon Linux 2 / Ubuntu). Adjust GID if
# your EC2 host uses a different group ID: check with `getent group docker`
RUN addgroup -g 999 -S docker 2>/dev/null || true \
 && adduser -S -u 1001 -G docker nodeapp \
 || adduser -S -u 1001 nodeapp

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Create required directories
RUN mkdir -p logs uploads assets

# Ensure log/upload dirs are writable by the app user
RUN chown -R nodeapp:docker logs uploads assets 2>/dev/null \
 || chown -R nodeapp logs uploads assets

USER nodeapp

# Expose backend port
EXPOSE 5000

# Health check — hits the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:5000/health || exit 1

# Start with PM2 in no-daemon mode (Docker-friendly)
# Uses ecosystem.config.js for cluster mode (4 instances)
CMD ["pm2-runtime", "ecosystem.config.js", "--env", "production"]
