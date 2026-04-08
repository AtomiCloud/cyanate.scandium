#!/bin/bash
# Ensure output directories exist and are writable by scraper user
# This runs as root via gosu, then drops to scraper user
mkdir -p /app/output/pages
chown -R scraper:scraper /app/output
exec gosu scraper bun run index.ts "$@"
