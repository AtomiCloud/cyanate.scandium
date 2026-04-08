FROM oven/bun:1 AS base

# Install Node.js (needed by Agent SDK subprocess) and Playwright dependencies
RUN apt-get update && apt-get install -y \
    curl \
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

# Install Node.js 22 (Agent SDK needs it)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (Agent SDK spawns it as subprocess)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Install Playwright browsers
RUN bunx playwright install chromium

# Create non-root user (Claude Code refuses bypassPermissions as root)
RUN useradd -m -s /bin/bash scraper

# Copy source
COPY --chown=scraper:scraper . .

# Create output directory
RUN mkdir -p output && chown scraper:scraper output

# Install gosu for dropping privileges in entrypoint
RUN apt-get update && apt-get install -y gosu && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Entrypoint runs as root, creates dirs, then drops to scraper user via gosu
ENTRYPOINT ["/app/entrypoint.sh"]
