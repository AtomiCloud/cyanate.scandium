import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { DomCandidate, DomElement } from './types.js';

// --- Types ---

export interface SchemaSection {
  selector: string;
  name: string;
  description: string;
  kind: 'section' | 'repeated_item' | 'global';
  multiple: boolean;
}

export interface SchemaState {
  sections: SchemaSection[];
}

export interface GlobalComponent {
  selector: string;
  count: number;
  total: number;
}

export function normalizeSchemaState(state: SchemaState): SchemaState {
  return {
    sections: state.sections.map((section) => ({
      ...section,
      multiple: section.kind === 'repeated_item' ? true : section.multiple,
    })),
  };
}

const GENERIC_LAYOUT_TOKENS = new Set([
  'container',
  'wrapper',
  'wrap',
  'row',
  'col',
  'column',
  'columns',
  'inner',
  'outer',
  'layout',
  'grid',
  'flex',
  'widget',
  'module',
  'block',
  'component',
  'builder',
  'elementor',
  'section',
]);

// --- Content Extraction using CSS Selectors ---

/**
 * Extract content from HTML using CSS selectors from the schema.
 * For each selector, extracts all text, images, links, and forms within.
 */
export function extractContent(html: string, sections: SchemaSection[], baseUrl: string): Record<string, unknown> {
  const $ = cheerio.load(html);
  const content: Record<string, unknown> = {};

  for (const section of sections) {
    const $matches = $(section.selector);
    if ($matches.length === 0) {
      content[section.name] = null;
      continue;
    }

    if (section.multiple) {
      content[section.name] = $matches
        .map((_, el) => extractElementContent($(el), $, baseUrl, section))
        .get();
      continue;
    }

    content[section.name] = extractElementContent($matches.first(), $, baseUrl, section);
  }

  return content;
}

function extractElementContent(
  $el: cheerio.Cheerio<AnyNode>,
  $: cheerio.CheerioAPI,
  baseUrl: string,
  section?: SchemaSection
): unknown {
  const result: Record<string, unknown> = {};
  const scoped = section?.kind === 'global' ? trimGlobalElement($el, $) : $el;

  // Extract all text (including from children)
  const fullText = scoped.text().trim();
  if (fullText) {
    result.text = fullText;
  }

  // Extract images
  const images = scoped.find('img').map((_, img) => {
    const $img = $(img);
    const src = $img.attr('src') || '';
    return {
      src: resolveUrl(src, baseUrl),
      alt: $img.attr('alt') || '',
    };
  }).get();
  if (images.length > 0) {
    result.images = images;
  }

  // Extract links
  const links = scoped.find('a[href]').map((_, a) => {
    const $a = $(a);
    return {
      href: resolveUrl($a.attr('href') || '', baseUrl),
      text: $a.text().trim(),
    };
  }).get();
  if (links.length > 0) {
    result.links = links;
  }

  // Extract form fields
  const formFields = scoped.find('input, select, textarea').map((_, field) => {
    const $field = $(field);
    return {
      type: $field.attr('type') || $field.prop('tagName')?.toLowerCase(),
      name: $field.attr('name') || '',
      placeholder: $field.attr('placeholder') || '',
    };
  }).get();
  if (formFields.length > 0) {
    result.form_fields = formFields;
  }

  return result;
}

function trimGlobalElement(
  $el: cheerio.Cheerio<AnyNode>,
  $: cheerio.CheerioAPI
): cheerio.Cheerio<AnyNode> {
  const clone = $el.clone();
  clone.find('form, .e-n-menu-content, .elementor-form, .flatpickr-calendar, [role="dialog"], .wa__popup_chat_box').remove();
  return clone;
}

function resolveUrl(url: string, baseUrl: string): string {
  if (!url || url.startsWith('data:') || url.startsWith('#') || url.startsWith('javascript:')) {
    return url;
  }
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

// --- Detect Global Components ---

/**
 * Detect selectors that appear across most page types.
 */
export function detectGlobalComponents(schemaStates: Record<string, SchemaState>): GlobalComponent[] {
  const selectorCounts = new Map<string, number>();
  const total = Object.keys(schemaStates).length;

  for (const state of Object.values(schemaStates)) {
    const seen = new Set<string>();
    for (const section of state.sections) {
      if (!seen.has(section.selector)) {
        seen.add(section.selector);
        selectorCounts.set(section.selector, (selectorCounts.get(section.selector) || 0) + 1);
      }
    }
  }

  const globals: GlobalComponent[] = [];
  const threshold = Math.ceil(total * 0.8);

  for (const [selector, count] of selectorCounts) {
    if (count >= threshold) {
      globals.push({ selector, count, total });
    }
  }

  return globals;
}

export function reduceDomCandidates(elements: DomElement[]): DomCandidate[] {
  const candidates = elements.map(scoreElementCandidate);
  const kept = candidates.filter(shouldKeepCandidate);
  const deduped = dedupeCandidates(kept);
  return deduped.sort((a, b) => b.score - a.score || a.depth - b.depth);
}

function scoreElementCandidate(element: DomElement): DomCandidate {
  let score = 0;
  const rejectionReasons: string[] = [];
  const hasOwnContent = element.directTextLength >= 30 || element.ownImageCount > 0 || element.hasForm;
  const hasDescendantContent = element.totalTextLength >= 60 || element.descendantImageCount > 0 || element.descendantLinkCount > 0;
  const genericTokenCount = element.classTokensNormalized.filter(token => GENERIC_LAYOUT_TOKENS.has(token)).length;
  const likelyWrapper =
    element.meaningfulChildCount <= 1 &&
    !hasOwnContent &&
    element.totalTextLength > 0 &&
    element.totalTextLength > element.directTextLength * 4;
  const likelyRepeated = element.repeatedSiblingCount >= 2;

  if (element.isSemanticTag) score += 3;
  if (element.id) score += 2;
  if (hasOwnContent) score += 3;
  if (hasDescendantContent) score += 1;
  if (element.hasForm) score += 2;
  if (element.descendantImageCount >= 2) score += 1;
  if (likelyRepeated) score += 2;
  if (element.depth >= 2 && element.depth <= 9) score += 1;
  if (element.meaningfulChildCount >= 2 && element.meaningfulChildCount <= 12) score += 2;
  if (element.totalTextLength > 120 && element.totalTextLength < 3000) score += 1;
  if (element.inMainContent) score += 4;
  if (element.containsHeading) score += 3;
  if (!element.inChromeRegion && (element.containsHeading || element.totalTextLength > 180 || element.ownImageCount > 0)) {
    score += 3;
  }

  if (genericTokenCount > 0) {
    score -= Math.min(3, genericTokenCount);
    rejectionReasons.push('generic_layout_tokens');
  }
  if (element.inChromeRegion && !element.inMainContent) {
    score -= 5;
    rejectionReasons.push('inside_chrome_region');
  }
  if (likelyWrapper) {
    score -= 4;
    rejectionReasons.push('single_meaningful_child_wrapper');
  }
  if (element.depth > 12 && !hasOwnContent) {
    score -= 2;
    rejectionReasons.push('very_deep_leaf');
  }
  if (element.directTextLength < 8 && element.totalTextLength > 400 && element.meaningfulChildCount >= 3) {
    score -= 3;
    rejectionReasons.push('inherits_most_content');
  }
  if (element.totalTextLength < 10 && !element.hasForm && element.descendantImageCount === 0 && element.descendantLinkCount < 2) {
    score -= 2;
    rejectionReasons.push('low_signal');
  }
  if (element.selector.includes('flatpickr') || element.selector.includes('menu-') || element.selector.includes('popup')) {
    score -= 4;
    rejectionReasons.push('ui_overlay_or_menu');
  }
  let structuralRole: DomCandidate['structuralRole'] = 'section_candidate';
  if (element.inChromeRegion || (element.isSemanticTag && ['header', 'footer', 'nav', 'aside'].includes(element.tag))) {
    structuralRole = 'chrome_candidate';
  } else if (likelyRepeated) {
    structuralRole = 'repeated_item_candidate';
  }

  return {
    ...element,
    score,
    structuralRole,
    likelyRepeated,
    likelyWrapper,
    rejectionReasons,
  };
}

function shouldKeepCandidate(candidate: DomCandidate): boolean {
  if (candidate.score >= 4) return true;
  if (candidate.hasForm) return true;
  if (!candidate.inChromeRegion && (candidate.containsHeading || candidate.totalTextLength > 180)) return true;
  if (candidate.inMainContent && candidate.containsHeading) return true;
  if (candidate.isSemanticTag && candidate.totalTextLength >= 40 && candidate.inMainContent) return true;
  if (candidate.likelyRepeated && candidate.inMainContent && (candidate.directTextLength >= 20 || candidate.ownImageCount > 0 || candidate.descendantLinkCount > 0)) return true;
  return false;
}

function dedupeCandidates(candidates: DomCandidate[]): DomCandidate[] {
  const bySelector = new Map<string, DomCandidate>();

  for (const candidate of candidates) {
    const existing = bySelector.get(candidate.selector);
    if (!existing || candidate.score > existing.score) {
      bySelector.set(candidate.selector, candidate);
    }
  }

  const unique = Array.from(bySelector.values());
  const kept: DomCandidate[] = [];

  for (const candidate of unique) {
    const parent = candidate.parentSelector ? bySelector.get(candidate.parentSelector) : undefined;
    if (
      parent &&
      parent.score >= candidate.score &&
      parent.meaningfulChildCount === 1 &&
      parent.directTextLength <= candidate.directTextLength &&
      parent.structuralRole === candidate.structuralRole
    ) {
      continue;
    }
    kept.push(candidate);
  }

  return kept;
}
