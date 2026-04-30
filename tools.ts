import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let PAGES_DIR = 'output/pages';

export function setPagesDir(dir: string) {
  PAGES_DIR = dir;
}

function ensurePagesDir() {
  mkdirSync(PAGES_DIR, { recursive: true });
}

export function urlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/$/, '') || '/index';
    return `${pathname.replace(/^\//, '').replace(/\//g, '_')}.html`;
  } catch {
    return `${url.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
  }
}

export function savePage(url: string, html: string): string {
  ensurePagesDir();
  const filename = urlToFilename(url);
  const filepath = path.join(PAGES_DIR, filename);
  writeFileSync(filepath, html, 'utf-8');
  return filepath;
}
