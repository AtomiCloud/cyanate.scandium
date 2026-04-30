// --- Crawler types ---

export interface DomElement {
  selector: string;
  tag: string;
  classes: string[];
  id: string;
  depth: number;
  parentSelector: string | null;
  ancestorSelectors: string[];
  textPreview: string;
  childCount: number;
  meaningfulChildCount: number;
  repeatedSiblingCount: number;
  directTextLength: number;
  totalTextLength: number;
  ownLinkCount: number;
  descendantLinkCount: number;
  ownImageCount: number;
  descendantImageCount: number;
  hasForm: boolean;
  isSemanticTag: boolean;
  classTokensNormalized: string[];
  inMainContent: boolean;
  inChromeRegion: boolean;
  containsHeading: boolean;
}

export interface DomCandidate extends DomElement {
  score: number;
  structuralRole:
    | 'section_candidate'
    | 'repeated_item_candidate'
    | 'chrome_candidate';
  likelyRepeated: boolean;
  likelyWrapper: boolean;
  rejectionReasons: string[];
}

export interface CrawlResult {
  url: string;
  html: string;
  links: string[];
  elements: DomElement[];
  candidates: DomCandidate[];
}

// --- Structure types (Phase 2 output) ---

export interface PageType {
  name: string;
  url_pattern: string;
  description: string;
  sample_urls: string[];
  urls: string[];
}

export interface SiteStructure {
  site_url: string;
  scraped_at: string;
  primary_language: string;
  total_crawled: number;
  total_kept: number;
  page_types: PageType[];
}

export interface FilteredPage {
  url: string;
  reason: string;
}

export interface FilteredOutput {
  total_filtered: number;
  pages: FilteredPage[];
}

// --- Schema types (Phase 3 output) ---

export interface SchemaOutput {
  pages: {
    [pagetype: string]: {
      $schema: string;
      type: string;
      properties: Record<string, unknown>;
    };
  };
}

// --- Content types (Phase 4 output) ---

export interface ContentEntry {
  url: string;
  content: unknown;
}

export interface GroupedContentOutput {
  page_types: {
    [pagetype: string]: {
      entries: ContentEntry[];
    };
  };
}
