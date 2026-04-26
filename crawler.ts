import { chromium, type Browser, type Page } from 'playwright';
import { reduceDomCandidates } from './schema-extractor.js';
import type { CrawlResult, DomElement } from './types.js';

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
    .replace(/\s+(?:style|data-[\w-]+|aria-[\w-]+|role|tabindex|fetchpriority|decoding|loading|srcset|sizes|width|height)="[^"]*"/gi, '')
    .replace(/\s+(?:style|data-[\w-]+|aria-[\w-]+|role|tabindex|fetchpriority|decoding|loading|srcset|sizes|width|height)='[^']*'/gi, '')
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
    const elements = await extractDomElements(page);
    const candidates = reduceDomCandidates(elements);
    const processedHtml = preprocessHtml(html);

    return { url, html: processedHtml, links, elements, candidates };
  } catch (error) {
    console.error(`  Error crawling ${url}:`, error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    await context.close();
  }
}

async function extractDomElements(page: Page): Promise<DomElement[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await page.evaluate((): any[] => {
    const results: any[] = [];
    const skip = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'BR', 'HR', 'WBR', 'SVG', 'PATH']);
    const semanticTags = new Set(['HEADER', 'FOOTER', 'NAV', 'MAIN', 'ARTICLE', 'ASIDE', 'SECTION']);
    const meaningfulTagNames = new Set(['SECTION', 'ARTICLE', 'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'FORM', 'UL', 'OL', 'LI']);
    const genericClassTokens = new Set(['elementor', 'elementor-element', 'e-con', 'e-child', 'e-parent', 'e-flex', 'container', 'wrapper', 'row', 'col', 'inner', 'outer', 'widget']);

    function getSelector(el: any): string {
      const tag = el.tagName.toLowerCase();
      const id = el.getAttribute('id');
      if (id) return `#${id}`;

      const classes = Array.from(el.classList).filter((c: any) => {
        if (c.length < 2) return false;
        if (/^[0-9]/.test(c as string)) return false;
        return true;
      }) as string[];
      const preferred = classes.find((c) => /^elementor-element-[a-z0-9]+$/i.test(c))
        || classes.find((c) => c.includes('__'))
        || classes.find((c) => c.includes('--'))
        || classes.find((c) => !genericClassTokens.has(c.toLowerCase()))
        || classes[0];
      if (preferred) return `${tag}.${preferred}`;
      return tag;
    }

    function getAncestorSelectors(el: any): string[] {
      const selectors: string[] = [];
      let current = el.parentElement;
      while (current && current.tagName !== 'BODY') {
        selectors.unshift(getSelector(current));
        current = current.parentElement;
      }
      return selectors.slice(-4);
    }

    function getDepth(el: any): number {
      let depth = 0;
      let current = el.parentElement;
      while (current) { depth++; current = current.parentElement; }
      return depth;
    }

    function normalizeClassTokens(classes: string[]): string[] {
      const tokens = new Set<string>();
      for (const cls of classes) {
        const parts = cls
          .replace(/([a-z])([A-Z])/g, '$1-$2')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
        for (const part of parts) {
          if (part.length >= 3) tokens.add(part);
        }
      }
      return Array.from(tokens).slice(0, 8);
    }

    function hasMainContentAncestor(el: any): boolean {
      let current = el;
      while (current) {
        const id = (current.getAttribute?.('id') || '').toLowerCase();
        const classes = Array.from(current.classList || []).map((c: any) => String(c).toLowerCase());
        if (
          current.tagName === 'MAIN' ||
          current.tagName === 'ARTICLE' ||
          id === 'content' ||
          id === 'primary' ||
          id === 'main' ||
          classes.some((cls: string) => ['content', 'primary', 'main-content', 'entry-content', 'post-content', 'article-content', 'site-main'].includes(cls))
        ) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    }

    function hasChromeAncestor(el: any): boolean {
      let current = el.parentElement;
      while (current && current.tagName !== 'BODY') {
        const id = (current.getAttribute?.('id') || '').toLowerCase();
        const classes = Array.from(current.classList || []).map((c: any) => String(c).toLowerCase());
        const isMenuLike = classes.some((cls: string) =>
          cls === 'e-n-menu' ||
          cls.startsWith('e-n-menu') ||
          cls.startsWith('elementor-nav-menu') ||
          cls.includes('breadcrumb')
        );
        const isPopupLike = classes.some((cls: string) =>
          cls.startsWith('wa__') ||
          cls.startsWith('flatpickr') ||
          cls.includes('popup')
        );
        const isHeaderFooterLike = classes.some((cls: string) =>
          cls === 'elementor-location-header' ||
          cls === 'elementor-location-footer' ||
          cls.includes('site-header') ||
          cls.includes('site-footer')
        );
        if (
          current.tagName === 'HEADER' ||
          current.tagName === 'FOOTER' ||
          current.tagName === 'NAV' ||
          id === 'wa' ||
          id.startsWith('menu-') ||
          isMenuLike ||
          isPopupLike ||
          isHeaderFooterLike
        ) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    }

    function getDirectTextLength(el: any): number {
      return Array.from(el.childNodes)
        .filter((n: any) => n.nodeType === 3)
        .map((n: any) => n.textContent?.trim() || '')
        .join(' ')
        .trim()
        .length;
    }

    function countMeaningfulChildren(el: any): number {
      let count = 0;
      for (const child of el.children) {
        if (skip.has(child.tagName)) continue;
        const classes = Array.from(child.classList);
        const hasMeaningfulClass = classes.length > 0;
        const hasId = !!child.getAttribute('id');
        const hasOwnText = getDirectTextLength(child) >= 20;
        const hasMedia = child.querySelector('img, picture, video, iframe') !== null;
        const hasForm = child.querySelector('form, input, select, textarea, button') !== null;
        const isMeaningfulTag = meaningfulTagNames.has(child.tagName);
        if (hasMeaningfulClass || hasId || hasOwnText || hasMedia || hasForm || isMeaningfulTag) {
          count++;
        }
      }
      return count;
    }

    function getRepeatedSiblingCount(el: any): number {
      if (!el.parentElement) return 0;
      const tag = el.tagName;
      const classKey = Array.from(el.classList).slice(0, 2).join('.');
      let count = 0;
      for (const sibling of el.parentElement.children) {
        if (sibling.tagName !== tag) continue;
        const siblingClassKey = Array.from(sibling.classList).slice(0, 2).join('.');
        if (classKey && siblingClassKey === classKey) {
          count++;
        } else if (!classKey) {
          count++;
        }
      }
      return Math.max(0, count - 1);
    }

    function walk(el: any) {
      if (skip.has(el.tagName)) return;

      const tag = el.tagName.toLowerCase();
      const id = el.getAttribute('id') || '';
      const classes = Array.from(el.classList);
      const isSemantic = semanticTags.has(el.tagName);

      // Only include elements with class, id, or semantic tags
      if (!id && classes.length === 0 && !isSemantic) {
        // Still walk children
        for (const child of el.children) walk(child);
        return;
      }

      const directText = Array.from(el.childNodes)
        .filter((n: any) => n.nodeType === 3)
        .map((n: any) => n.textContent?.trim() || '')
        .join(' ')
        .trim();
      const fullText = (el.textContent || '').trim();
      const textPreview = (directText || fullText).substring(0, 150);
      const ownLinks = el.matches('a[href]') ? 1 : 0;
      const descendantLinks = el.querySelectorAll('a[href]').length;
      const ownImages = el.matches('img, picture, video, iframe') ? 1 : 0;
      const descendantImages = el.querySelectorAll('img, picture, video, iframe').length;
      const containsHeading = el.querySelector('h1, h2, h3, h4, h5, h6') !== null;

      results.push({
        selector: getSelector(el),
        tag,
        classes,
        id,
        depth: getDepth(el),
        parentSelector: el.parentElement && el.parentElement.tagName !== 'BODY' ? getSelector(el.parentElement) : null,
        ancestorSelectors: getAncestorSelectors(el),
        textPreview,
        childCount: el.children.length,
        meaningfulChildCount: countMeaningfulChildren(el),
        repeatedSiblingCount: getRepeatedSiblingCount(el),
        directTextLength: directText.length,
        totalTextLength: fullText.length,
        ownLinkCount: ownLinks,
        descendantLinkCount: descendantLinks,
        ownImageCount: ownImages,
        descendantImageCount: descendantImages,
        hasForm: el.matches('form') || el.querySelector('form, input, select, textarea, button') !== null,
        isSemanticTag: isSemantic,
        classTokensNormalized: normalizeClassTokens(classes as string[]),
        inMainContent: hasMainContentAncestor(el),
        inChromeRegion: hasChromeAncestor(el),
        containsHeading,
      });

      // Walk children
      for (const child of el.children) walk(child);
    }

    walk(document.body);
    return results;
  });
  } catch (error) {
    console.error('  Error extracting DOM elements:', error instanceof Error ? error.message : String(error));
    return [];
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
