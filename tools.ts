import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import path from 'path';

const PAGES_DIR = 'output/pages';

function ensurePagesDir() {
  mkdirSync(PAGES_DIR, { recursive: true });
}

export function urlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    let pathname = parsed.pathname.replace(/\/$/, '') || '/index';
    return pathname.replace(/^\//, '').replace(/\//g, '_') + '.html';
  } catch {
    return url.replace(/[^a-zA-Z0-9]/g, '_') + '.html';
  }
}

export function savePage(url: string, html: string): string {
  ensurePagesDir();
  const filename = urlToFilename(url);
  const filepath = path.join(PAGES_DIR, filename);
  writeFileSync(filepath, html, 'utf-8');
  return filepath;
}

export function listPages(): { total: number; files: string[] } {
  ensurePagesDir();
  const files = existsSync(PAGES_DIR)
    ? readdirSync(PAGES_DIR)
        .filter((f) => f.endsWith('.html'))
        .map((f) => path.join(PAGES_DIR, f))
    : [];
  return { total: files.length, files };
}
