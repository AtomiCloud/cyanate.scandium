import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { crawlSite } from './crawler.js';
import { savePage, urlToFilename } from './tools.js';
import { extractContentFromHtml } from './api.js';
import type { SiteStructure, FilteredOutput, SchemaOutput, GroupedContentOutput, PageType } from './types.js';

// --- Config ---
const CRAWL_CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY || '10');
const EXTRACT_CONCURRENCY = parseInt(process.env.EXTRACT_CONCURRENCY || '5');
const EXTRACT_RETRIES = 3;
const OUTPUT_DIR = 'output';
const PAGES_DIR = path.join(OUTPUT_DIR, 'pages');

// --- TUI Helpers ---
function printPhaseHeader(phase: number, name: string) {
  console.log(`\n${'━'.repeat(50)}`);
  console.log(`  Phase ${phase}: ${name}`);
  console.log(`${'━'.repeat(50)}`);
}

function printPhaseSummary(stats: Record<string, string | number>) {
  for (const [key, value] of Object.entries(stats)) {
    console.log(`  ${key}: ${value}`);
  }
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

// --- Helpers ---
function normalizeSchema(raw: any): SchemaOutput {
  // Case 1: already correct format { pages: { landing: {...}, doctor_profile: {...} } }
  if (raw.pages && typeof raw.pages === 'object' && !raw.pages.type) {
    return raw as SchemaOutput;
  }
  // Case 2: wrapped in JSON Schema { properties: { pages: { properties: { ... } } } }
  if (raw.properties?.pages?.properties) {
    return { pages: raw.properties.pages.properties };
  }
  // Case 3: flat object with page type keys at top level { landing: {...}, doctor_profile: {...} }
  if (!raw.pages && !raw.properties) {
    const keys = Object.keys(raw).filter(k => !k.startsWith('$') && k !== 'title' && k !== 'description' && k !== 'type' && k !== 'additionalProperties');
    if (keys.length > 0 && typeof raw[keys[0]] === 'object') {
      return { pages: Object.fromEntries(keys.map(k => [k, raw[k]])) };
    }
  }
  throw new Error('Could not parse schema.json — unexpected format. Check the file manually.');
}

// --- Phase 1: Crawl ---
async function phase1Crawl(websiteUrl: string): Promise<void> {
  printPhaseHeader(1, 'Crawl');
  const startTime = Date.now();

  if (existsSync(PAGES_DIR) && readdirSync(PAGES_DIR).filter(f => f.endsWith('.html')).length > 0) {
    const count = readdirSync(PAGES_DIR).filter(f => f.endsWith('.html')).length;
    console.log(`  Skipping — ${count} pages already on disk`);
    printPhaseSummary({ 'Pages on disk': count, 'Time': 'skipped' });
    return;
  }

  mkdirSync(PAGES_DIR, { recursive: true });

  const results = await crawlSite(websiteUrl, { concurrency: CRAWL_CONCURRENCY });

  for (const result of results) {
    savePage(result.url, result.html);
  }

  const elapsed = Date.now() - startTime;
  printPhaseSummary({
    'Pages crawled': results.length,
    'Tokens': 0,
    'Time': formatTime(elapsed),
    'Saved to': PAGES_DIR,
  });
}

// --- Phase 2: Structure Analysis (Agent) ---
async function phase2Structure(websiteUrl: string): Promise<void> {
  printPhaseHeader(2, 'Structure Analysis');
  const startTime = Date.now();

  if (existsSync(path.join(OUTPUT_DIR, 'structure.json'))) {
    console.log('  Skipping — structure.json already exists');
    return;
  }

  // Gather all crawled URLs from disk
  const pageFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.html'));
  const urls = pageFiles.map(f => {
    // Reverse urlToFilename: about-us.html → /about-us/
    const name = f.replace('.html', '');
    if (name === 'index') return '/';
    return '/' + name.replace(/_/g, '/') + '/';
  });

  const urlList = urls.map((u, i) => `${i + 1}. ${u} (file: ${PAGES_DIR}/${pageFiles[i]})`).join('\n');

  const systemPrompt = `You are a website structure analyzer. Your job is to analyze crawled URLs, filter out auto-generated pages, and group the remaining pages by type.

## Step 1: Filter Pages

### MUST filter (skip these immediately):
- Non-primary language pages: URLs under /zh/, /ja/, /fr/, /de/, /es/ etc. These are translations — filter ALL of them. Do NOT create separate _zh or _ja page types.
- Date archives: URLs that are purely date-based paths like /2024/03/29/, /2025/01/
- Pagination: URLs containing /page/2/, /page/3/ etc.
- Category/tag listing pages: URLs like /category/articles/, /doctor-category/cardiology/ — these just list/filter content that exists on individual pages

### MUST verify before filtering:
For any other ambiguous URL, use the Read tool to check the HTML:
- If the page body is just a list of links/cards to other pages with no unique content → skip
- If the page has unique text, images, forms, or information → keep

### The Rule
If a page has unique content worth rebuilding, keep it. If it's a transition/listing/pagination page or non-primary language translation, skip it.

## Step 2: Group Kept Pages by Type

Be SPECIFIC with page types. Do NOT lump different pages into a generic "static_page" type. Each distinct kind of page should have its own type.

Examples of good page types:
- landing — the homepage (/)
- about — about us page (/about-us/)
- service_overview — main services listing (/our-services/)
- service_detail — individual service pages (/specialist-care/, /diagnostics-imaging/)
- team_listing — meet the team page (/meet-our-team/)
- doctor_profile — individual doctor pages (/doctor/{slug}/)
- blog_post — individual articles/news posts
- blog_listing — news/articles index page (/news-events/)
- event_listing — events page (/events/)
- patient_journey — patient journey page
- contact — contact page
- legal — privacy policy, terms & conditions

Rules:
- Pages with the same URL path structure = same page type
- Use {slug} or {id} for variable parts
- Unique pages (/, /about-us/, /our-services/) each get their own type if they have distinct content/layout
- Do NOT group unrelated pages together just because they're "static"

## Output
Write EXACTLY two files and nothing else:

1. output/structure.json — kept pages grouped by type
2. output/filtered.json — skipped pages with reasons

DO NOT write any other files. DO NOT write schema.json — that is handled by a later phase.

IMPORTANT: Every crawled URL must appear in exactly one of these files. No pages missing.`;

  const prompt = `Analyze this website: ${websiteUrl}

${pageFiles.length} pages were crawled. Here are all the URLs:

${urlList}

The cleaned HTML for each page is saved on disk. Use the Read tool to inspect any page you need to verify.

Write output/structure.json with this format:
{
  "site_url": "${websiteUrl}",
  "scraped_at": "${new Date().toISOString()}",
  "primary_language": "en",
  "total_crawled": ${pageFiles.length},
  "total_kept": <number>,
  "page_types": [
    {
      "name": "doctor_profile",
      "url_pattern": "/doctor/{slug}/",
      "description": "Individual doctor profile page",
      "sample_urls": ["/doctor/dr-someone/", "/doctor/dr-other/"],
      "urls": ["/doctor/dr-someone/", "/doctor/dr-other/", ...]
    }
  ]
}

Write output/filtered.json with this format:
{
  "total_filtered": <number>,
  "pages": [
    { "url": "/2024/03/29/", "reason": "Date archive — no unique content" }
  ]
}`;

  const conversation = query({
    prompt,
    options: {
      executable: 'node',
      systemPrompt,
      tools: ['Read', 'Write', 'Glob'],
      allowedTools: ['Read', 'Write', 'Glob'],
      maxTurns: 50,
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });

  let turns = 0;
  const heartbeat = setInterval(() => {
    console.log(`  ⏳ Still working... (${formatTime(Date.now() - startTime)})`);
  }, 30000);

  for await (const message of conversation) {
    if (message.type === 'assistant') {
      turns++;
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          console.log(`  🔧 ${block.name} ${typeof block.input === 'object' ? JSON.stringify(block.input).substring(0, 80) : ''}`);
        }
      }
    }
    if (message.type === 'result') {
      clearInterval(heartbeat);
      const resultMsg = message as SDKResultMessage;
      if (resultMsg.subtype !== 'success') {
        throw new Error(`Phase 2 failed: ${resultMsg.subtype}`);
      }
    }
  }
  clearInterval(heartbeat);

  // Read outputs and validate
  const elapsed = Date.now() - startTime;
  const structure: SiteStructure = JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'structure.json'), 'utf-8'));
  const filtered: FilteredOutput = existsSync(path.join(OUTPUT_DIR, 'filtered.json'))
    ? JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'filtered.json'), 'utf-8'))
    : { total_filtered: 0, pages: [] };

  // --- Validation: find pages on disk missing from both structure and filtered ---
  const allStructureUrls = new Set<string>();
  for (const pt of structure.page_types) {
    for (const url of pt.urls) allStructureUrls.add(url);
  }
  const allFilteredUrls = new Set(filtered.pages.map(p => p.url));
  const allAccountedUrls = new Set([...allStructureUrls, ...allFilteredUrls]);

  // Reconstruct URLs from filenames on disk
  const diskFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.html'));
  const diskUrls = diskFiles.map(f => {
    const name = f.replace('.html', '');
    if (name === 'index') return '/';
    return '/' + name.replace(/_/g, '/') + '/';
  });

  const missingUrls: string[] = [];
  for (const url of diskUrls) {
    if (!allAccountedUrls.has(url)) {
      missingUrls.push(url);
    }
  }

  // Try to assign missing pages to existing page types by matching URL patterns
  if (missingUrls.length > 0) {
    console.log(`  ⚠ Validation: ${missingUrls.length} pages on disk not accounted for by agent`);

    let autoFixed = 0;
    for (const url of missingUrls) {
      // Try to match against existing page type patterns
      let matched = false;
      for (const pt of structure.page_types) {
        // Check if this URL matches the pattern of this page type
        // e.g., /doctor/dr-amy-wong/ matches /doctor/{slug}/
        const patternParts = pt.url_pattern.split('/').filter(Boolean);
        const urlParts = url.split('/').filter(Boolean);

        if (patternParts.length === urlParts.length) {
          const matches = patternParts.every((part, i) =>
            part.startsWith('{') || part === urlParts[i]
          );
          if (matches) {
            pt.urls.push(url);
            matched = true;
            autoFixed++;
            console.log(`    ✓ Auto-added ${url} → ${pt.name}`);
            break;
          }
        }
      }
      if (!matched) {
        console.log(`    ? Could not auto-assign: ${url}`);
      }
    }

    if (autoFixed > 0) {
      // Update totals and save
      structure.total_kept = structure.page_types.reduce((sum, pt) => sum + pt.urls.length, 0);
      writeFileSync(path.join(OUTPUT_DIR, 'structure.json'), JSON.stringify(structure, null, 2), 'utf-8');
      console.log(`  ✓ Auto-fixed: added ${autoFixed} missing pages to structure.json`);
    }
  }

  printPhaseSummary({
    'Total crawled': structure.total_crawled,
    'Pages kept': `${structure.total_kept} (${structure.page_types.length} types)`,
    'Pages filtered': filtered.total_filtered,
    'Turns': turns,
    'Time': formatTime(elapsed),
  });

  // Show page types
  for (const pt of structure.page_types) {
    console.log(`    ${pt.name}: ${pt.urls.length} pages (${pt.url_pattern})`);
  }
}

// --- Phase 3: Schema Generation (Agent) ---
async function phase3Schema(): Promise<void> {
  printPhaseHeader(3, 'Schema Generation');
  const startTime = Date.now();

  if (existsSync(path.join(OUTPUT_DIR, 'schema.json'))) {
    console.log('  Skipping — schema.json already exists');
    return;
  }

  const structure: SiteStructure = JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'structure.json'), 'utf-8'));

  const typesSummary = structure.page_types.map(pt =>
    `- ${pt.name} (${pt.urls.length} pages, pattern: ${pt.url_pattern})\n  Samples: ${pt.sample_urls.join(', ')}\n  All URLs: ${pt.urls.join(', ')}`
  ).join('\n');

  const systemPrompt = `You are a JSON Schema designer. Your job is to create a comprehensive union JSON Schema (draft-07) for each page type of a website.

## Rules
- For each page type, read enough sample pages to capture ALL section variations
- If a group has ≤30 pages, read ALL of them
- If a group has >30 pages, read samples until you stop seeing new sections
- Create a UNION schema that covers all variations (some pages may have sections others don't)
- Use semantic property names: hero_section, navigation, services, testimonials, etc.
- Capture: text, images (src + alt), links (label + href), forms (fields, labels, types), buttons/CTAs
- Include header, navigation (full menu hierarchy), and footer sections
- Use arrays for repeated elements

## Output
Write output/schema.json with this format:
{
  "pages": {
    "<pagetype>": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": { ... }
    }
  }
}`;

  const prompt = `Generate JSON Schemas for these page types:

${typesSummary}

The cleaned HTML for each page is at output/pages/<filename>.html. Use the Read tool to examine pages.

Read enough pages per type to capture all variations. Write the result to output/schema.json.`;

  const conversation = query({
    prompt,
    options: {
      executable: 'node',
      systemPrompt,
      tools: ['Read', 'Write', 'Glob'],
      allowedTools: ['Read', 'Write', 'Glob'],
      maxTurns: 100,
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });

  let turns = 0;
  const heartbeat = setInterval(() => {
    console.log(`  ⏳ Still working... (${formatTime(Date.now() - startTime)})`);
  }, 30000);

  for await (const message of conversation) {
    if (message.type === 'assistant') {
      turns++;
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          console.log(`  🔧 ${block.name} ${typeof block.input === 'object' ? JSON.stringify(block.input).substring(0, 80) : ''}`);
        }
      }
    }
    if (message.type === 'result') {
      clearInterval(heartbeat);
      const resultMsg = message as SDKResultMessage;
      if (resultMsg.subtype !== 'success') {
        throw new Error(`Phase 3 failed: ${resultMsg.subtype}`);
      }
    }
  }
  clearInterval(heartbeat);

  const elapsed = Date.now() - startTime;
  const schemaRaw = JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'schema.json'), 'utf-8'));
  // Normalize: agent might write { pages: {...} } or wrap in JSON Schema with { properties: { pages: { properties: {...} } } }
  const schema: SchemaOutput = normalizeSchema(schemaRaw);
  writeFileSync(path.join(OUTPUT_DIR, 'schema.json'), JSON.stringify(schema, null, 2), 'utf-8');
  const typeCount = Object.keys(schema.pages).length;

  printPhaseSummary({
    'Page types': structure.page_types.length,
    'Schemas generated': typeCount,
    'Turns': turns,
    'Time': formatTime(elapsed),
  });
}

// --- Phase 4: Content Extraction (Programmatic) ---
async function phase4Content(websiteUrl: string): Promise<void> {
  printPhaseHeader(4, 'Content Extraction');
  const startTime = Date.now();

  if (existsSync(path.join(OUTPUT_DIR, 'content.json'))) {
    console.log('  Skipping — content.json already exists');
    return;
  }

  const structure: SiteStructure = JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'structure.json'), 'utf-8'));
  const schema: SchemaOutput = normalizeSchema(JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'schema.json'), 'utf-8')));

  // Build URL → page type mapping
  const urlToType = new Map<string, string>();
  for (const pt of structure.page_types) {
    for (const url of pt.urls) {
      urlToType.set(url, pt.name);
    }
  }

  // Build a map of all HTML files on disk for fast lookup
  const allFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.html'));
  const fileSet = new Set(allFiles);

  // Build list of pages to extract
  const pagesToExtract: Array<{ url: string; pagetype: string; file: string }> = [];
  for (const pt of structure.page_types) {
    for (const url of pt.urls) {
      // Try multiple filename derivations
      const candidates = [
        urlToFilename(websiteUrl.replace(/\/$/, '') + url),
        urlToFilename(url),
        urlToFilename(websiteUrl + url.replace(/^\//, '')),
      ];

      const match = candidates.find(f => fileSet.has(f));
      if (match) {
        pagesToExtract.push({ url, pagetype: pt.name, file: path.join(PAGES_DIR, match) });
      } else {
        console.warn(`  ⚠ File not found for ${url}, skipping`);
      }
    }
  }

  console.log(`  Pages to extract: ${pagesToExtract.length}`);

  // Extract in parallel with concurrency limit
  const output: GroupedContentOutput = { page_types: {} };
  let completed = 0;
  let failed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Initialize page_types
  for (const pt of structure.page_types) {
    output.page_types[pt.name] = { entries: [] };
  }

  // Process in batches
  for (let i = 0; i < pagesToExtract.length; i += EXTRACT_CONCURRENCY) {
    const batch = pagesToExtract.slice(i, i + EXTRACT_CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (page) => {
        const html = readFileSync(page.file, 'utf-8');
        const pageSchema = schema.pages[page.pagetype];

        if (!pageSchema) {
          throw new Error(`No schema for type: ${page.pagetype}`);
        }

        // Retry logic
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= EXTRACT_RETRIES; attempt++) {
          try {
            const content = await extractContentFromHtml(html, pageSchema, websiteUrl, page.url);
            return { url: page.url, pagetype: page.pagetype, content };
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < EXTRACT_RETRIES) {
              const delay = attempt * 2000;
              await new Promise((r) => setTimeout(r, delay));
            }
          }
        }
        throw lastError;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { url, pagetype, content } = result.value;
        output.page_types[pagetype].entries.push({ url, content });
        completed++;
      } else {
        failed++;
        console.error(`  ✗ ${result.reason}`);
      }
    }

    console.log(`  Progress: ${completed + failed}/${pagesToExtract.length} (${failed} failed)`);
  }

  // Write output
  writeFileSync(path.join(OUTPUT_DIR, 'content.json'), JSON.stringify(output, null, 2), 'utf-8');

  const elapsed = Date.now() - startTime;
  printPhaseSummary({
    'Pages to extract': pagesToExtract.length,
    'Extracted': completed,
    'Failed': failed,
    'API calls': completed + failed,
    'Time': formatTime(elapsed),
  });
}

// --- Main ---
async function main() {
  const websiteUrl = process.argv[2];
  const phaseArg = process.argv.indexOf('--phase');
  const singlePhase = phaseArg !== -1 ? parseInt(process.argv[phaseArg + 1]) : null;

  if (!websiteUrl) {
    console.error('Usage: bun run index.ts <website-url> [--phase N]');
    console.error('Example: bun run index.ts https://example.com');
    console.error('         bun run index.ts https://example.com --phase 3');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('Error: Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in .env');
    process.exit(1);
  }

  console.log(`\n🌐 Website Scraper — ${websiteUrl}`);
  console.log(`   Model: ${process.env.LLM_MODEL || 'claude-sonnet-4-6'}`);
  if (singlePhase) console.log(`   Running phase ${singlePhase} only`);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const totalStart = Date.now();

  if (!singlePhase || singlePhase === 1) await phase1Crawl(websiteUrl);
  if (!singlePhase || singlePhase === 2) await phase2Structure(websiteUrl);
  if (!singlePhase || singlePhase === 3) await phase3Schema();
  if (!singlePhase || singlePhase === 4) await phase4Content(websiteUrl);

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`  ✅ All phases complete`);
  console.log(`  Total time: ${formatTime(Date.now() - totalStart)}`);
  console.log(`  Output: ${OUTPUT_DIR}/`);
  console.log(`${'━'.repeat(50)}\n`);
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
