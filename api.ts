import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS_CONTENT || '16384', 10);

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    // Support both ANTHROPIC_API_KEY (standard) and ANTHROPIC_AUTH_TOKEN (MiniMax/custom providers)
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseURL = process.env.ANTHROPIC_BASE_URL || undefined;

    if (authToken) {
      client = new Anthropic({ authToken, baseURL });
    } else if (apiKey) {
      client = new Anthropic({ apiKey, baseURL });
    } else {
      throw new Error('Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in .env');
    }
  }
  return client;
}

export function extractJSON(text: string): string {
  if (!text) return '';
  text = text.trim();

  if (text.startsWith('```json')) {
    text = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');
  } else if (text.startsWith('```')) {
    text = text.replace(/^```\s*/, '').replace(/```\s*$/, '');
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  return text.trim();
}

// --- Global Name Standardization (Step 3d) ---

export interface StandardizeResult {
  mapping: Record<string, string>;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Ask LLM to standardize key names for global components across page types.
 * Ensures the same raw key gets the same readable name everywhere.
 */
export async function standardizeGlobalNames(
  perTypeMapping: Record<string, Record<string, string>>,
  globalKeys: string[],
): Promise<StandardizeResult> {
  // Show what each page type currently calls each global component
  const lines: string[] = [];
  for (const rawKey of globalKeys) {
    const names: string[] = [];
    for (const [pageType, mapping] of Object.entries(perTypeMapping)) {
      if (mapping[rawKey]) {
        names.push(`${pageType}: "${mapping[rawKey]}"`);
      }
    }
    lines.push(
      `Raw key "${rawKey}" is currently named:\n  ${names.join('\n  ')}`,
    );
  }

  const prompt = `You are standardizing key names for shared website components.

These components appear across multiple page types of the same website. Each page type may have given them a different readable name. Pick ONE canonical name for each that should be used everywhere.

Rules:
- Use snake_case
- Pick the most descriptive and common name
- Output ONLY valid JSON: a mapping from raw key to the canonical readable name

Components to standardize:

${lines.join('\n\n')}

Output format:
{
  "raw_key_1": "canonical_name",
  "raw_key_2": "canonical_name"
}`;

  const anthropic = getClient();
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });
  const response = await stream.finalMessage();

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const jsonText = extractJSON(text);
  const mapping = JSON.parse(jsonText) as Record<string, string>;

  return {
    mapping,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}
