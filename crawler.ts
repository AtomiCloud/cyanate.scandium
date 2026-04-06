import { chromium, type Browser, type Page } from 'playwright';
import type { CrawlResult } from './types.js';

export interface CrawlerOptions {
  concurrency?: number;
}

export async function crawlSite(
  baseUrl: string,
  options: CrawlerOptions = {}
): Promise<CrawlResult[]> {
  const { concurrency = 50 } = options;
  const browser = await chromium.launch({ headless: true });
  const results: CrawlResult[] = [];
  const visited = new Set<string>();
  const queued = new Set<string>([baseUrl]);
  const toVisit: string[] = [baseUrl];
  const baseUrlObj = new URL(baseUrl);
  const baseDomain = baseUrlObj.hostname;

  console.log(`  Starting crawl with concurrency=${concurrency}`);

  try {
    let batchNum = 0;
    while (toVisit.length > 0) {
      batchNum++;
      const batchSize = Math.min(concurrency, toVisit.length);
      const batch: string[] = [];
      for (let i = 0; i < batchSize; i++) {
        const url = toVisit.shift();
        if (url && !visited.has(url)) {
          batch.push(url);
          visited.add(url);
        }
      }

      if (batch.length === 0) continue;

      console.log(`  [Batch ${batchNum}] Crawling ${batch.length} pages (${visited.size} visited, ${toVisit.length} queued)`);

      const batchResults = await Promise.allSettled(
        batch.map((url) => crawlPage(browser, url, baseUrl, baseDomain))
      );

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
          for (const link of result.value.links) {
            if (!visited.has(link) && !queued.has(link)) {
              queued.add(link);
              toVisit.push(link);
            }
          }
        } else if (result.status === 'rejected') {
          console.error(`  Failed: ${batch[i]}`);
        }
      }
    }

    console.log(`  Crawl complete: ${results.length} pages`);
    return results;
  } finally {
    await browser.close();
  }
}

function preprocessHtml(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let content = bodyMatch ? bodyMatch[1] : html;

  content = content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '[svg]')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+(?:class|id|style|data-[\w-]+|aria-[\w-]+|role|tabindex|fetchpriority|decoding|loading|srcset|sizes|width|height)="[^"]*"/gi, '')
    .replace(/\s+(?:class|id|style|data-[\w-]+|aria-[\w-]+|role|tabindex|fetchpriority|decoding|loading|srcset|sizes|width|height)='[^']*'/gi, '')
    .replace(/<(div|span|i|em|b|strong)[^>]*>\s*<\/\1>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return content;
}

async function crawlPage(
  browser: Browser,
  url: string,
  baseUrl: string,
  baseDomain: string
): Promise<CrawlResult | null> {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    } catch {
      // networkidle timed out — wait for page to settle
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
      } catch {
        // already loaded
      }
      await page.waitForTimeout(3000);
    }

    const html = await page.content();
    const links = await extractLinks(page, baseUrl, baseDomain);
    const processedHtml = preprocessHtml(html);

    return { url, html: processedHtml, links };
  } catch (error) {
    console.error(`  Error crawling ${url}:`, error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    await context.close();
  }
}

async function extractLinks(
  page: Page,
  baseUrl: string,
  baseDomain: string
): Promise<string[]> {
  const links = await page.$$eval('a[href]', (anchors) =>
    anchors.map((a) => a.getAttribute('href')).filter(Boolean) as string[]
  );

  const uniqueLinks = new Set<string>();

  for (const link of links) {
    try {
      const absoluteUrl = new URL(link, baseUrl);
      if (absoluteUrl.hostname === baseDomain) {
        const normalizedUrl = absoluteUrl.origin + absoluteUrl.pathname;
        if (!normalizedUrl.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|ico)$/i)) {
          uniqueLinks.add(normalizedUrl);
        }
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return Array.from(uniqueLinks);
}
