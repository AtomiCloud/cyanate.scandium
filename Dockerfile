FROM oven/bun:1 AS base

# Install Node.js (needed by Agent SDK subprocess) and Playwright dependencies
RUN apt-get update && apt-get install -y \
    curl \
    nodejs \
    npm \
    # Playwright Chromium dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Install Playwright browsers
RUN bunx playwright install chromium

# Copy source
COPY . .

# Create output directory
RUN mkdir -p output

ENTRYPOINT ["bun", "run", "index.ts"]
