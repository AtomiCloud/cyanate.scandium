import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { crawlSite } from './crawler.js';
import { savePage, urlToFilename, setPagesDir } from './tools.js';
import { standardizeGlobalNames } from './api.js';
import { detectGlobalComponents, extractContent, normalizeSchemaState, type SchemaState, type SchemaSection } from './schema-extractor.js';
import type { SiteStructure, FilteredOutput, SchemaOutput, GroupedContentOutput, PageType } from './types.js';

// --- Config ---
const CRAWL_CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY || '10');
const EXTRACT_CONCURRENCY = parseInt(process.env.EXTRACT_CONCURRENCY || '5');
const EXTRACT_RETRIES = 3;
const SCHEMA_SAMPLE_MIN = parseInt(process.env.SCHEMA_SAMPLE_MIN || '20');
const SCHEMA_SAMPLE_RATIO = parseFloat(process.env.SCHEMA_SAMPLE_RATIO || '0.6');
const SCHEMA_BATCH_SIZE = parseInt(process.env.SCHEMA_BATCH_SIZE || '5');
const SCHEMA_CONCURRENCY = parseInt(process.env.SCHEMA_CONCURRENCY || '3');
const AGENT_MODEL = process.env.LLM_MODEL || undefined;
const AGENT_ENV: Record<string, string> = {};
if (process.env.ANTHROPIC_BASE_URL) AGENT_ENV.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
if (process.env.ANTHROPIC_AUTH_TOKEN) AGENT_ENV.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
if (process.env.ANTHROPIC_API_KEY) AGENT_ENV.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.DISABLE_THINKING) {
  AGENT_ENV.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1';
  AGENT_ENV.MAX_THINKING_TOKENS = '0';
}
const INPUT_COST_PER_M = parseFloat(process.env.INPUT_COST_PER_M || '1.40');
const OUTPUT_COST_PER_M = parseFloat(process.env.OUTPUT_COST_PER_M || '4.40');
let OUTPUT_DIR = '';
let PAGES_DIR = '';

// --- Cost Tracking ---
interface PhaseStats {
  name: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timeMs: number;
}

const phaseStats: PhaseStats[] = [];

function calcCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * INPUT_COST_PER_M + (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;
}

function recordPhase(name: string, inputTokens: number, outputTokens: number, timeMs: number) {
  const cost = calcCost(inputTokens, outputTokens);
  phaseStats.push({ name, inputTokens, outputTokens, cost, timeMs });
  console.log(`  Input tokens: ${inputTokens.toLocaleString()}`);
  console.log(`  Output tokens: ${outputTokens.toLocaleString()}`);
  console.log(`  Cost: $${cost.toFixed(4)}`);
}

function printTotalSummary(totalTimeMs: number) {
  const totals = phaseStats.reduce(
    (acc, p) => ({
      inputTokens: acc.inputTokens + p.inputTokens,
      outputTokens: acc.outputTokens + p.outputTokens,
      cost: acc.cost + p.cost,
    }),
    { inputTokens: 0, outputTokens: 0, cost: 0 }
  );

  console.log(`\n${'━'.repeat(50)}`);
  console.log('  Cost Summary');
  console.log(`${'━'.repeat(50)}`);
  for (const p of phaseStats) {
    console.log(`  ${p.name}: $${p.cost.toFixed(4)} (${p.inputTokens.toLocaleString()} in / ${p.outputTokens.toLocaleString()} out) [${formatTime(p.timeMs)}]`);
  }
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Total: $${totals.cost.toFixed(4)} (${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out)`);
  console.log(`  Total time: ${formatTime(totalTimeMs)}`);
  console.log(`${'━'.repeat(50)}\n`);
}

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
function resolveRefs(schema: any): any {
  const defs = schema.$defs || schema.definitions || {};

  function resolve(node: any): any {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(resolve);

    if (node.$ref && typeof node.$ref === 'string') {
      // Parse "#/$defs/foo" or "#/definitions/foo"
      const match = node.$ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
      if (match && defs[match[2]]) {
        return resolve(structuredClone(defs[match[2]]));
      }
      return node;
    }

    const result: any = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$defs' || key === 'definitions' || key === '$schema') continue;
      result[key] = resolve(value);
    }
    return result;
  }

  return resolve(schema);
}

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

  const elementsDir = path.join(OUTPUT_DIR, 'elements');
  const candidatesDir = path.join(OUTPUT_DIR, 'candidates');
  mkdirSync(elementsDir, { recursive: true });
  mkdirSync(candidatesDir, { recursive: true });

  for (const result of results) {
    savePage(result.url, result.html);
    const baseFile = urlToFilename(result.url).replace('.html', '.json');
    writeFileSync(path.join(elementsDir, baseFile), JSON.stringify(result.elements, null, 2), 'utf-8');
    writeFileSync(path.join(candidatesDir, baseFile), JSON.stringify(result.candidates, null, 2), 'utf-8');
  }

  const elapsed = Date.now() - startTime;
  printPhaseSummary({
    'Pages crawled': results.length,
    'Candidate files': results.length,
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

  const systemPrompt = `You are a website structure analyzer. Your job is to analyze crawled URLs, filter out duplicate/auto-generated pages, and group the remaining pages by type.

## Step 1: Filter Pages

Only filter pages that are truly duplicates or auto-generated with no unique content:

- **Non-primary language translations**: URLs under language prefixes like /zh/, /ja/, /fr/, /de/, /es/ etc. These are translations of pages that already exist in the primary language — filter ALL of them.
- **Date-only archives**: URLs that are purely date-based paths like /2024/03/29/, /2025/01/ — these are auto-generated date indexes with no unique content.
- **Pagination**: URLs containing /page/2/, /page/3/ etc. — these are just paginated views of existing listing pages.

### KEEP everything else
Keep ALL pages that have any unique content, layout, or purpose — including:
- Category/tag listing pages (these group content and may have unique layouts)
- Search results pages
- Any page with content that a user would want to visit

### When unsure
Use the Read tool to check the HTML. If the page has any unique text, images, forms, or information beyond just navigation — keep it.

## Step 2: Group Kept Pages by Type

Be SPECIFIC with page types. Do NOT lump different pages into a generic "static_page" type. Each distinct kind of page should have its own type.

Rules:
- Pages with the same URL path structure and similar layout = same page type
- Use {slug} or {id} for variable parts in URL patterns
- Unique standalone pages each get their own type if they have distinct content/layout
- Do NOT group unrelated pages together just because they're "static"

## Output
Write EXACTLY two files and nothing else:

1. ${OUTPUT_DIR}/structure.json — kept pages grouped by type
2. ${OUTPUT_DIR}/filtered.json — skipped pages with reasons

DO NOT write any other files. DO NOT write schema.json — that is handled by a later phase.

IMPORTANT: Every crawled URL must appear in exactly one of these files. No pages missing.`;

  const prompt = `Analyze this website: ${websiteUrl}

${pageFiles.length} pages were crawled. Here are all the URLs:

${urlList}

The cleaned HTML for each page is saved on disk. Use the Read tool to inspect any page you need to verify.

Write ${OUTPUT_DIR}/structure.json with this format:
{
  "site_url": "${websiteUrl}",
  "scraped_at": "${new Date().toISOString()}",
  "primary_language": "<detected primary language>",
  "total_crawled": ${pageFiles.length},
  "total_kept": <number>,
  "page_types": [
    {
      "name": "<descriptive_snake_case_name>",
      "url_pattern": "/<path>/{slug}/",
      "description": "<what this page type represents>",
      "sample_urls": ["<example url 1>", "<example url 2>"],
      "urls": ["<all urls of this type>"]
    }
  ]
}

Write ${OUTPUT_DIR}/filtered.json with this format:
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
      ...(AGENT_MODEL ? { model: AGENT_MODEL } : {}),
      ...(Object.keys(AGENT_ENV).length > 0 ? { env: { ...process.env, ...AGENT_ENV } } : {}),
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
      const usage = resultMsg.usage ?? { input_tokens: 0, output_tokens: 0 };
      recordPhase('Phase 2: Structure', usage.input_tokens ?? 0, usage.output_tokens ?? 0, Date.now() - startTime);
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
    const unmatched: string[] = [];
    for (const url of missingUrls) {
      // Find the most specific matching page type (most literal segments)
      const urlParts = url.split('/').filter(Boolean);
      let bestMatch: PageType | null = null;
      let bestLiteralCount = -1;

      for (const pt of structure.page_types) {
        const patternParts = pt.url_pattern.split('/').filter(Boolean);

        if (patternParts.length === urlParts.length) {
          const matches = patternParts.every((part, i) =>
            part.startsWith('{') || part === urlParts[i]
          );
          if (matches) {
            const literalCount = patternParts.filter(p => !p.startsWith('{')).length;
            if (literalCount > bestLiteralCount) {
              bestLiteralCount = literalCount;
              bestMatch = pt;
            }
          }
        }
      }

      if (bestMatch) {
        bestMatch.urls.push(url);
        autoFixed++;
        console.log(`    ✓ Auto-added ${url} → ${bestMatch.name}`);
      } else {
        unmatched.push(url);
        console.log(`    ? Could not auto-assign: ${url}`);
      }
    }

    // Create individual page types for unmatched pages so they get schemas and content extraction
    if (unmatched.length > 0) {
      for (const url of unmatched) {
        const parts = url.split('/').filter(Boolean);
        const typeName = parts.length > 0 ? parts.join('_') : 'index';
        structure.page_types.push({
          name: typeName,
          url_pattern: url,
          description: `Standalone page: ${url}`,
          sample_urls: [url],
          urls: [url],
        });
        autoFixed++;
        console.log(`    ✓ Created page type "${typeName}" for ${url}`);
      }
    }

    if (autoFixed > 0) {
      // Deduplicate urls within each page type
      for (const pt of structure.page_types) {
        pt.urls = [...new Set(pt.urls)];
      }
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

// --- Phase 3: Schema Generation (Agent SDK + programmatic) ---
async function phase3Schema(websiteUrl: string): Promise<void> {
  printPhaseHeader(3, 'Schema Generation');
  const startTime = Date.now();

  if (existsSync(path.join(OUTPUT_DIR, 'schema.json'))) {
    console.log('  Skipping — schema.json already exists');
    return;
  }

  const structure: SiteStructure = JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'structure.json'), 'utf-8'));
  const allFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.html'));
  const fileSet = new Set(allFiles);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // --- Step 3a: LLM identifies sections per page type (Agent SDK) ---
  console.log('  Step 3a: Identifying sections per page type...');

  const schemaStates: Record<string, SchemaState> = {};

  // Build file lists per page type
  const pageTypeFiles: Array<{ name: string; files: string[] }> = [];
  for (const pt of structure.page_types) {
    const files: string[] = [];
    for (const url of pt.urls) {
      const candidates = [
        urlToFilename(websiteUrl.replace(/\/$/, '') + url),
        urlToFilename(url),
        urlToFilename(websiteUrl + url.replace(/^\//, '')),
      ];
      const match = candidates.find(f => fileSet.has(f));
      if (match) files.push(path.join(PAGES_DIR, match));
    }

    // Sampling: use all pages if ≤ SCHEMA_SAMPLE_MIN, otherwise use SCHEMA_SAMPLE_RATIO
    let sampled: string[];
    if (files.length <= SCHEMA_SAMPLE_MIN) {
      sampled = files;
    } else {
      const count = Math.ceil(files.length * SCHEMA_SAMPLE_RATIO);
      // Shuffle and take count
      const shuffled = [...files].sort(() => Math.random() - 0.5);
      sampled = shuffled.slice(0, count);
    }

    if (sampled.length > 0) {
      pageTypeFiles.push({ name: pt.name, files: sampled });
      console.log(`    ${pt.name}: ${sampled.length}/${files.length} pages to analyze`);
    }
  }

  // Run agent sessions in parallel (SCHEMA_CONCURRENCY at a time)
  for (let i = 0; i < pageTypeFiles.length; i += SCHEMA_CONCURRENCY) {
    const batch = pageTypeFiles.slice(i, i + SCHEMA_CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(pt => runSchemaAgent(pt.name, pt.files))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const ptName = batch[j].name;
      if (result.status === 'fulfilled') {
        validateSchemaState(ptName, result.value.state);
        schemaStates[ptName] = result.value.state;
        totalInputTokens += result.value.usage.input_tokens;
        totalOutputTokens += result.value.usage.output_tokens;
        console.log(`    ✓ ${ptName}: ${result.value.state.sections.length} sections found (${result.value.usage.input_tokens + result.value.usage.output_tokens} tokens)`);
      } else {
        console.error(`    ✗ ${ptName}: ${result.reason}`);
      }
    }
  }

  // Read back all schema state files from disk (catches agents that wrote files but whose promise rejected)
  for (const pt of pageTypeFiles) {
    if (schemaStates[pt.name]) continue; // already captured from promise
    const stateFile = path.join(OUTPUT_DIR, `schema-state-${pt.name}.json`);
    if (existsSync(stateFile)) {
      const recovered = JSON.parse(readFileSync(stateFile, 'utf-8')) as SchemaState;
      try {
        validateSchemaState(pt.name, recovered);
        schemaStates[pt.name] = recovered;
        console.log(`    ✓ ${pt.name}: ${schemaStates[pt.name].sections.length} sections (recovered from disk)`);
      } catch (error) {
        console.error(`    ✗ ${pt.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  console.log(`  Step 3a complete: ${Object.keys(schemaStates).length} page types`);

  // --- Step 3b: Detect global components (programmatic) ---
  console.log('  Step 3b: Detecting global components...');
  const globals = detectGlobalComponents(schemaStates);

  for (const g of globals) {
    console.log(`    Global: ${g.selector} (${g.count}/${g.total} page types)`);
  }
  console.log(`  Step 3b complete: ${globals.length} global components`);

  // --- Step 3c: Standardize global names (LLM API call) ---
  if (globals.length > 0) {
    console.log('  Step 3c: Standardizing global component names...');

    const globalSelectors = globals.map(g => g.selector);

    // Build per-type mappings from schema states (selector → name)
    const perTypeMappings: Record<string, Record<string, string>> = {};
    for (const [ptName, state] of Object.entries(schemaStates)) {
      perTypeMappings[ptName] = {};
      for (const section of state.sections) {
        perTypeMappings[ptName][section.selector] = section.name;
      }
    }

    const standardResult = await standardizeGlobalNames(perTypeMappings, globalSelectors);
    totalInputTokens += standardResult.usage.input_tokens;
    totalOutputTokens += standardResult.usage.output_tokens;

    // Apply standardized names back to schema states
    for (const [selector, canonicalName] of Object.entries(standardResult.mapping)) {
      for (const state of Object.values(schemaStates)) {
        for (const section of state.sections) {
          if (section.selector === selector) {
            section.name = canonicalName;
          }
        }
      }
    }

    console.log(`  Step 3c complete: ${Object.keys(standardResult.mapping).length} keys standardized`);
  } else {
    console.log('  Step 3c: No global components to standardize');
  }

  // --- Step 3d: Generate schema.json (programmatic) ---
  console.log('  Step 3d: Generating final schema...');
  const schemaOutput: SchemaOutput = { pages: {} };

  for (const [ptName, state] of Object.entries(schemaStates)) {
    const properties: Record<string, unknown> = {};

    for (const section of state.sections) {
      properties[section.name] = {
        type: section.multiple ? 'array' : 'object',
        description: section.description,
        _selector: section.selector,
        _kind: section.kind,
        _multiple: section.multiple,
      };
    }

    schemaOutput.pages[ptName] = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties,
    };
  }

  writeFileSync(path.join(OUTPUT_DIR, 'schema.json'), JSON.stringify(schemaOutput, null, 2), 'utf-8');

  const elapsed = Date.now() - startTime;
  recordPhase('Phase 3: Schema', totalInputTokens, totalOutputTokens, elapsed);

  printPhaseSummary({
    'Page types': Object.keys(schemaStates).length,
    'Global components': globals.length,
    'Time': formatTime(elapsed),
  });
}

interface SchemaAgentResult {
  state: SchemaState;
  usage: { input_tokens: number; output_tokens: number };
}

function validateSchemaState(pageType: string, state: SchemaState): void {
  const nonGlobal = state.sections.filter(s => s.kind !== 'global');
  if (nonGlobal.length === 0) {
    throw new Error(`Schema agent produced only global sections for ${pageType}`);
  }
}

function compactCandidateFiles(pageType: string, candidateFiles: string[]): string[] {
  const compactDir = path.join(OUTPUT_DIR, 'candidates-compact');
  mkdirSync(compactDir, { recursive: true });

  return candidateFiles.map((file, idx) => {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Array<Record<string, unknown>>;
    const compact = raw
      .slice(0, 40)
      .map((candidate) => ({
        selector: candidate.selector,
        tag: candidate.tag,
        parentSelector: candidate.parentSelector,
        depth: candidate.depth,
        score: candidate.score,
        structuralRole: candidate.structuralRole,
        repeatedSiblingCount: candidate.repeatedSiblingCount,
        meaningfulChildCount: candidate.meaningfulChildCount,
        totalTextLength: candidate.totalTextLength,
        directTextLength: candidate.directTextLength,
        ownImageCount: candidate.ownImageCount,
        descendantImageCount: candidate.descendantImageCount,
        descendantLinkCount: candidate.descendantLinkCount,
        containsHeading: candidate.containsHeading,
        inMainContent: candidate.inMainContent,
        inChromeRegion: candidate.inChromeRegion,
        classTokensNormalized: candidate.classTokensNormalized,
        textPreview: candidate.textPreview,
      }));

    const compactFile = path.join(compactDir, `${pageType}-${idx + 1}.json`);
    writeFileSync(compactFile, JSON.stringify(compact, null, 2), 'utf-8');
    return compactFile;
  });
}

/** Run one Agent SDK session to identify sections for a page type */
async function runSchemaAgent(pageType: string, files: string[]): Promise<SchemaAgentResult> {
  const stateFile = path.join(OUTPUT_DIR, `schema-state-${pageType}.json`);

  // Convert HTML file paths to reduced candidate JSON file paths
  const candidatesDir = path.join(OUTPUT_DIR, 'candidates');
  const candidateFiles = files.map(f => {
    const base = path.basename(f).replace('.html', '.json');
    return path.join(candidatesDir, base);
  }).filter(f => existsSync(f));

  const compactCandidatePaths = compactCandidateFiles(pageType, candidateFiles);
  const fileList = compactCandidatePaths.map((f, i) => `${i + 1}. ${f}`).join('\n');

  const systemPrompt = `You are a web page structure analyzer. You will read JSON files containing REDUCED candidate elements extracted from web pages. Each candidate already survived generic pruning. Each record has a verified CSS selector plus structural signals such as parentSelector, repeatedSiblingCount, directTextLength, totalTextLength, meaningfulChildCount, and structuralRole.

Your job is to identify which candidates are MEANINGFUL CONTENT SECTIONS for a CMS template.

## What is a meaningful section?
- A self-contained component: header, navigation, hero banner, content area, card grid, article body, profile, form, footer, chat widget, popup
- Represents a distinct part of the page that a CMS template or content model would need
- Can be either a single section or a repeated item selector

## How to use the signals
- "directTextLength" low + "totalTextLength" high + one meaningful child usually means wrapper
- "repeatedSiblingCount >= 2" often means repeated items or list entries
- "structuralRole = chrome_candidate" often means global UI like header/footer/nav
- Prefer the best semantic boundary, not the broadest ancestor and not the tiniest leaf

## Classification rules
- Use kind = "global" for shared chrome such as site_header, main_navigation, site_footer
- Use kind = "repeated_item" when the selector should match multiple peer entries such as cards, team members, news cards, FAQ items
- Use kind = "section" for normal one-off page sections
- Set multiple = true only when the selector should intentionally extract an array of matches
- Keep the selectors exactly as given
- Every page type must include at least one NON-GLOBAL page-specific content section or repeated-item selector. Globals alone are never enough.

## IMPORTANT
- Do not output wrappers that just contain the real section
- Do not miss the main page content while capturing chrome
- Do not invent selectors or rename selectors
- Prefer stable reusable sections over one-off formatting leaves
- Strongly prefer candidates inside main content over booking menus, popup widgets, datepickers, nav menus, and floating UI
- Ignore flatpickr calendars, popup internals, menu internals, and duplicated navigation leaves unless the page type is literally a navigation/listing component

## Output format
Write the state file with this JSON format:
{
  "sections": [
    {
      "selector": "<exact selector from the candidate>",
      "name": "readable_name",
      "description": "what this section contains",
      "kind": "section | repeated_item | global",
      "multiple": false
    }
  ]
}

## Process
1. Read candidate files in batches of ${SCHEMA_BATCH_SIZE}
2. After each batch, read the current state file (if it exists) and add any NEW sections you find
3. Never remove existing sections — only add new ones
4. Write the updated state file after each batch`;

  const prompt = `Analyze the reduced DOM candidates for page type "${pageType}".

Here are the candidate files to read (${compactCandidatePaths.length} pages):

${fileList}

Each file contains a reduced array of candidate elements with verified CSS selectors and structural metadata. Pick the meaningful sections and repeated item selectors.

Read them in batches of ${SCHEMA_BATCH_SIZE}. After each batch, update the state file at: ${stateFile}

Start by reading the first ${Math.min(SCHEMA_BATCH_SIZE, compactCandidatePaths.length)} files.`;

  const conversation = query({
    prompt,
    options: {
      executable: 'node',
      systemPrompt,
      tools: ['Read', 'Write', 'Glob'],
      allowedTools: ['Read', 'Write', 'Glob'],
      maxTurns: Math.ceil(files.length / SCHEMA_BATCH_SIZE) * 20 + 50,
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(AGENT_MODEL ? { model: AGENT_MODEL } : {}),
      ...(Object.keys(AGENT_ENV).length > 0 ? { env: { ...process.env, ...AGENT_ENV } } : {}),
    },
  });

  let agentUsage = { input_tokens: 0, output_tokens: 0 };

  for await (const message of conversation) {
    if (message.type === 'result') {
      const resultMsg = message as SDKResultMessage;
      const usage = resultMsg.usage ?? { input_tokens: 0, output_tokens: 0 };
      agentUsage = { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 };
      if (resultMsg.subtype !== 'success') {
        throw new Error(`Schema agent failed for ${pageType}: ${resultMsg.subtype}`);
      }
    }
  }

  // Read the final state file
  if (!existsSync(stateFile)) {
    throw new Error(`Schema agent did not create state file for ${pageType}`);
  }

  const state = normalizeSchemaState(JSON.parse(readFileSync(stateFile, 'utf-8')) as SchemaState);
  validateSchemaState(pageType, state);

  return {
    state,
    usage: agentUsage,
  };
}

// --- Phase 4: Content Extraction (Programmatic — no LLM) ---
async function phase4Content(websiteUrl: string): Promise<void> {
  printPhaseHeader(4, 'Content Extraction');
  const startTime = Date.now();

  if (existsSync(path.join(OUTPUT_DIR, 'content.json'))) {
    console.log('  Skipping — content.json already exists');
    return;
  }

  const structure: SiteStructure = JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'structure.json'), 'utf-8'));
  const schema: SchemaOutput = JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'schema.json'), 'utf-8'));

  // Build section lookup per page type (name → selector from schema)
  const sectionsByType = new Map<string, SchemaSection[]>();
  for (const [ptName, ptSchema] of Object.entries(schema.pages)) {
    const sections: SchemaSection[] = [];
    for (const [name, prop] of Object.entries(ptSchema.properties as Record<string, any>)) {
      sections.push({
        selector: prop._selector || '',
        name,
        description: prop.description || '',
        kind: prop._kind || 'section',
        multiple: Boolean(prop._multiple),
      });
    }
    sectionsByType.set(ptName, sections);
  }

  // Build a map of all HTML files on disk for fast lookup
  const allFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.html'));
  const fileSet = new Set(allFiles);

  // Build list of pages to extract
  const pagesToExtract: Array<{ url: string; pagetype: string; file: string }> = [];
  for (const pt of structure.page_types) {
    for (const url of pt.urls) {
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

  const output: GroupedContentOutput = { page_types: {} };
  let completed = 0;
  let failed = 0;

  // Initialize page_types
  for (const pt of structure.page_types) {
    output.page_types[pt.name] = { entries: [] };
  }

  // Extract content programmatically — no LLM
  for (const page of pagesToExtract) {
    try {
      const html = readFileSync(page.file, 'utf-8');
      const sections = sectionsByType.get(page.pagetype);

      if (!sections || sections.length === 0) {
        throw new Error(`No schema sections for type: ${page.pagetype}`);
      }

      const content = extractContent(html, sections, websiteUrl);
      output.page_types[page.pagetype].entries.push({ url: page.url, content });
      completed++;
    } catch (error) {
      failed++;
      console.error(`  ✗ ${page.url}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if ((completed + failed) % 20 === 0 || completed + failed === pagesToExtract.length) {
      console.log(`  Progress: ${completed + failed}/${pagesToExtract.length} (${failed} failed)`);
    }
  }

  // Write output
  writeFileSync(path.join(OUTPUT_DIR, 'content.json'), JSON.stringify(output, null, 2), 'utf-8');

  const elapsed = Date.now() - startTime;
  recordPhase('Phase 4: Content', 0, 0, elapsed);

  printPhaseSummary({
    'Pages to extract': pagesToExtract.length,
    'Extracted': completed,
    'Failed': failed,
    'LLM calls': 0,
    'Time': formatTime(elapsed),
  });
}

// --- Main ---
async function main() {
  const websiteUrl = process.argv[2];
  const phaseArg = process.argv.indexOf('--phase');
  const singlePhase = phaseArg !== -1 ? parseInt(process.argv[phaseArg + 1]) : null;
  const outputArg = process.argv.indexOf('--output');
  const outputName = outputArg !== -1 ? process.argv[outputArg + 1] : null;

  if (!websiteUrl) {
    console.error('Usage: bun run index.ts <website-url> [--phase N] [--output <name>]');
    console.error('Example: bun run index.ts https://example.com');
    console.error('         bun run index.ts https://example.com --phase 3');
    console.error('         bun run index.ts https://example.com --output 2026-04-12_14-30-00');
    process.exit(1);
  }

  const timestamp = outputName || new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  OUTPUT_DIR = path.join('output', timestamp);
  PAGES_DIR = path.join(OUTPUT_DIR, 'pages');

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('Error: Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in .env');
    process.exit(1);
  }

  console.log(`\n🌐 Website Scraper — ${websiteUrl}`);
  console.log(`   Model: ${process.env.LLM_MODEL || 'claude-sonnet-4-6'}`);
  if (singlePhase) console.log(`   Running phase ${singlePhase} only`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  setPagesDir(PAGES_DIR);

  console.log(`   Output: ${OUTPUT_DIR}`);

  const totalStart = Date.now();

  if (!singlePhase || singlePhase === 1) await phase1Crawl(websiteUrl);
  if (!singlePhase || singlePhase === 2) await phase2Structure(websiteUrl);
  if (!singlePhase || singlePhase === 3) await phase3Schema(websiteUrl);
  if (!singlePhase || singlePhase === 4) await phase4Content(websiteUrl);

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`  ✅ All phases complete`);
  console.log(`  Output: ${OUTPUT_DIR}/`);
  console.log(`${'━'.repeat(50)}`);

  printTotalSummary(Date.now() - totalStart);
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
