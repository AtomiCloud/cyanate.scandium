import { type Browser, chromium, type Page } from 'playwright';
import { reduceDomCandidates } from './schema-extractor.js';
import type { CrawlResult, DomElement } from './types.js';

export interface CrawlerOptions {
  concurrency?: number;
}

export async function crawlSite(
  baseUrl: string,
  options: CrawlerOptions = {},
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
      const batch = takeNextBatch(toVisit, visited, concurrency);

      if (batch.length === 0) continue;

      console.log(
        `  [Batch ${batchNum}] Crawling ${batch.length} pages (${visited.size} visited, ${toVisit.length} queued)`,
      );

      const crawled = await crawlBatch(browser, batch, baseUrl, baseDomain);
      for (const result of crawled) {
        results.push(result);
        enqueueDiscoveredLinks(result.links, visited, queued, toVisit);
      }
    }

    console.log(`  Crawl complete: ${results.length} pages`);
    return results;
  } finally {
    await browser.close();
  }
}

function takeNextBatch(
  toVisit: string[],
  visited: Set<string>,
  concurrency: number,
): string[] {
  const batchSize = Math.min(concurrency, toVisit.length);
  const batch: string[] = [];

  for (let i = 0; i < batchSize; i++) {
    const url = toVisit.shift();
    if (url && !visited.has(url)) {
      batch.push(url);
      visited.add(url);
    }
  }

  return batch;
}

async function crawlBatch(
  browser: Browser,
  batch: string[],
  baseUrl: string,
  baseDomain: string,
): Promise<CrawlResult[]> {
  const settled = await Promise.allSettled(
    batch.map((url) => crawlPage(browser, url, baseUrl, baseDomain)),
  );
  const results: CrawlResult[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled' && result.value) {
      results.push(result.value);
      continue;
    }

    if (result.status === 'rejected') {
      console.error(`  Failed: ${batch[i]}`);
    }
  }

  return results;
}

function enqueueDiscoveredLinks(
  links: string[],
  visited: Set<string>,
  queued: Set<string>,
  toVisit: string[],
) {
  for (const link of links) {
    if (!visited.has(link) && !queued.has(link)) {
      queued.add(link);
      toVisit.push(link);
    }
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
    .replace(
      /\s+(?:style|data-[\w-]+|aria-[\w-]+|role|tabindex|fetchpriority|decoding|loading|srcset|sizes|width|height)="[^"]*"/gi,
      '',
    )
    .replace(
      /\s+(?:style|data-[\w-]+|aria-[\w-]+|role|tabindex|fetchpriority|decoding|loading|srcset|sizes|width|height)='[^']*'/gi,
      '',
    )
    .replace(/<(div|span|i|em|b|strong)[^>]*>\s*<\/\1>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return content;
}

async function crawlPage(
  browser: Browser,
  url: string,
  baseUrl: string,
  baseDomain: string,
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
    console.error(
      `  Error crawling ${url}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  } finally {
    await context.close();
  }
}

async function extractDomElements(page: Page): Promise<DomElement[]> {
  try {
    return await page.evaluate((): DomElement[] => {
      const results: DomElement[] = [];
      const skip = new Set<string>([
        'HTML',
        'HEAD',
        'SCRIPT',
        'STYLE',
        'NOSCRIPT',
        'LINK',
        'META',
        'BR',
        'HR',
        'WBR',
        'SVG',
        'PATH',
      ]);
      const semanticTags = new Set<string>([
        'HEADER',
        'FOOTER',
        'NAV',
        'MAIN',
        'ARTICLE',
        'ASIDE',
        'SECTION',
      ]);
      const meaningfulTagNames = new Set<string>([
        'SECTION',
        'ARTICLE',
        'NAV',
        'ASIDE',
        'HEADER',
        'FOOTER',
        'MAIN',
        'FORM',
        'UL',
        'OL',
        'LI',
      ]);
      const genericClassTokens = new Set<string>([
        'elementor',
        'elementor-element',
        'e-con',
        'e-child',
        'e-parent',
        'e-flex',
        'container',
        'wrapper',
        'row',
        'col',
        'inner',
        'outer',
        'widget',
      ]);
      const mainContentClasses = new Set<string>([
        'content',
        'primary',
        'main-content',
        'entry-content',
        'post-content',
        'article-content',
        'site-main',
      ]);
      const mediaSelector = 'img, picture, video, iframe';
      const formSelector = 'form, input, select, textarea, button';

      function classNames(el: Element): string[] {
        return Array.from(el.classList);
      }

      function lowerClassNames(el: Element): string[] {
        return classNames(el).map((className) => className.toLowerCase());
      }

      function directText(el: Element): string {
        return Array.from(el.childNodes)
          .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim() || '')
          .join(' ')
          .trim();
      }

      function getSelector(el: Element): string {
        const tag = el.tagName.toLowerCase();
        const id = el.getAttribute('id');
        if (id) return `#${id}`;

        const classes = classNames(el).filter((className) => {
          if (className.length < 2) return false;
          if (/^[0-9]/.test(className)) return false;
          return true;
        });
        const preferred =
          classes.find((c) => /^elementor-element-[a-z0-9]+$/i.test(c)) ||
          classes.find((c) => c.includes('__')) ||
          classes.find((c) => c.includes('--')) ||
          classes.find((c) => !genericClassTokens.has(c.toLowerCase())) ||
          classes[0];
        if (preferred) return `${tag}.${preferred}`;
        return tag;
      }

      function getAncestorSelectors(el: Element): string[] {
        const selectors: string[] = [];
        let current = el.parentElement;
        while (current && current.tagName !== 'BODY') {
          selectors.unshift(getSelector(current));
          current = current.parentElement;
        }
        return selectors.slice(-4);
      }

      function getDepth(el: Element): number {
        let depth = 0;
        let current = el.parentElement;
        while (current) {
          depth++;
          current = current.parentElement;
        }
        return depth;
      }

      function hasMainContentIdentity(el: Element): boolean {
        const id = (el.getAttribute('id') || '').toLowerCase();
        const classes = lowerClassNames(el);
        return (
          el.tagName === 'MAIN' ||
          el.tagName === 'ARTICLE' ||
          id === 'content' ||
          id === 'primary' ||
          id === 'main' ||
          classes.some((className) => mainContentClasses.has(className))
        );
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

      function hasMainContentAncestor(el: Element): boolean {
        let current: Element | null = el;
        while (current) {
          if (hasMainContentIdentity(current)) {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      }

      function isMenuLike(classes: string[]): boolean {
        return classes.some(
          (className) =>
            className === 'e-n-menu' ||
            className.startsWith('e-n-menu') ||
            className.startsWith('elementor-nav-menu') ||
            className.includes('breadcrumb'),
        );
      }

      function isPopupLike(classes: string[]): boolean {
        return classes.some(
          (className) =>
            className.startsWith('wa__') ||
            className.startsWith('flatpickr') ||
            className.includes('popup'),
        );
      }

      function isHeaderFooterLike(classes: string[]): boolean {
        return classes.some(
          (className) =>
            className === 'elementor-location-header' ||
            className === 'elementor-location-footer' ||
            className.includes('site-header') ||
            className.includes('site-footer'),
        );
      }

      function isChromeElement(el: Element): boolean {
        const id = (el.getAttribute('id') || '').toLowerCase();
        const classes = lowerClassNames(el);
        return (
          el.tagName === 'HEADER' ||
          el.tagName === 'FOOTER' ||
          el.tagName === 'NAV' ||
          id === 'wa' ||
          id.startsWith('menu-') ||
          isMenuLike(classes) ||
          isPopupLike(classes) ||
          isHeaderFooterLike(classes)
        );
      }

      function hasChromeAncestor(el: Element): boolean {
        let current = el.parentElement;
        while (current && current.tagName !== 'BODY') {
          if (isChromeElement(current)) {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      }

      function getDirectTextLength(el: Element): number {
        return directText(el).length;
      }

      function isMeaningfulChild(child: Element): boolean {
        return [
          classNames(child).length > 0,
          Boolean(child.getAttribute('id')),
          getDirectTextLength(child) >= 20,
          child.querySelector(mediaSelector) !== null,
          child.querySelector(formSelector) !== null,
          meaningfulTagNames.has(child.tagName),
        ].some(Boolean);
      }

      function countMeaningfulChildren(el: Element): number {
        let count = 0;
        for (const child of el.children) {
          if (skip.has(child.tagName)) continue;
          if (isMeaningfulChild(child)) count++;
        }
        return count;
      }

      function siblingClassKey(el: Element): string {
        return classNames(el).slice(0, 2).join('.');
      }

      function isMatchingSibling(
        sibling: Element,
        tagName: string,
        classKey: string,
      ): boolean {
        return (
          sibling.tagName === tagName &&
          (!classKey || siblingClassKey(sibling) === classKey)
        );
      }

      function getRepeatedSiblingCount(el: Element): number {
        const parent = el.parentElement;
        if (!parent) return 0;

        const classKey = siblingClassKey(el);
        const matchingSiblings = Array.from(parent.children).filter((sibling) =>
          isMatchingSibling(sibling, el.tagName, classKey),
        );
        return Math.max(0, matchingSiblings.length - 1);
      }

      function getParentSelector(el: Element): string | null {
        if (!el.parentElement || el.parentElement.tagName === 'BODY') {
          return null;
        }
        return getSelector(el.parentElement);
      }

      function shouldRecordElement(
        id: string,
        classes: string[],
        isSemantic: boolean,
      ): boolean {
        return Boolean(id || classes.length > 0 || isSemantic);
      }

      function buildDomElement(el: Element): DomElement {
        const tag = el.tagName.toLowerCase();
        const id = el.getAttribute('id') || '';
        const classes = classNames(el);
        const isSemantic = semanticTags.has(el.tagName);
        const directTextValue = directText(el);
        const fullText = (el.textContent || '').trim();

        return {
          selector: getSelector(el),
          tag,
          classes,
          id,
          depth: getDepth(el),
          parentSelector: getParentSelector(el),
          ancestorSelectors: getAncestorSelectors(el),
          textPreview: (directTextValue || fullText).substring(0, 150),
          childCount: el.children.length,
          meaningfulChildCount: countMeaningfulChildren(el),
          repeatedSiblingCount: getRepeatedSiblingCount(el),
          directTextLength: directTextValue.length,
          totalTextLength: fullText.length,
          ownLinkCount: el.matches('a[href]') ? 1 : 0,
          descendantLinkCount: el.querySelectorAll('a[href]').length,
          ownImageCount: el.matches(mediaSelector) ? 1 : 0,
          descendantImageCount: el.querySelectorAll(mediaSelector).length,
          hasForm:
            el.matches('form') || el.querySelector(formSelector) !== null,
          isSemanticTag: isSemantic,
          classTokensNormalized: normalizeClassTokens(classes),
          inMainContent: hasMainContentAncestor(el),
          inChromeRegion: hasChromeAncestor(el),
          containsHeading: el.querySelector('h1, h2, h3, h4, h5, h6') !== null,
        };
      }

      function walkChildren(el: Element): void {
        for (const child of el.children) walk(child);
      }

      function walk(el: Element): void {
        if (skip.has(el.tagName)) return;

        const id = el.getAttribute('id') || '';
        const classes = classNames(el);
        const isSemantic = semanticTags.has(el.tagName);

        if (!shouldRecordElement(id, classes, isSemantic)) {
          walkChildren(el);
          return;
        }

        results.push(buildDomElement(el));
        walkChildren(el);
      }

      walk(document.body);
      return results;
    });
  } catch (error) {
    console.error(
      '  Error extracting DOM elements:',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

async function extractLinks(
  page: Page,
  baseUrl: string,
  baseDomain: string,
): Promise<string[]> {
  const links = await page.$$eval(
    'a[href]',
    (anchors) =>
      anchors.map((a) => a.getAttribute('href')).filter(Boolean) as string[],
  );

  const uniqueLinks = new Set<string>();

  for (const link of links) {
    try {
      const absoluteUrl = new URL(link, baseUrl);
      if (absoluteUrl.hostname === baseDomain) {
        const normalizedUrl = absoluteUrl.origin + absoluteUrl.pathname;
        if (
          !normalizedUrl.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|ico)$/i)
        ) {
          uniqueLinks.add(normalizedUrl);
        }
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return Array.from(uniqueLinks);
}
