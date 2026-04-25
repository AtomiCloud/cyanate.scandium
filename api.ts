import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS_CONTENT || '16384');

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

export interface ExtractionResult {
  content: unknown;
  usage: { input_tokens: number; output_tokens: number };
}

export async function extractContentFromHtml(
  html: string,
  schema: Record<string, unknown>,
  baseUrl: string,
  url: string
): Promise<ExtractionResult> {
  // Extract expected keys from schema properties
  const expectedKeys = schema.properties ? Object.keys(schema.properties as Record<string, unknown>) : [];

  const prompt = `Extract ALL visible content from this webpage HTML and return it as JSON.

IMPORTANT: Do NOT return the schema itself. Return the actual extracted content values from the HTML.

Your output JSON must have exactly these top-level keys: ${JSON.stringify(expectedKeys)}

Rules:
- Extract every piece of visible content: text, images (full absolute URLs), links, forms, buttons
- Resolve relative URLs to absolute using base: ${baseUrl}
- For arrays: extract ALL items, not samples
- Output ONLY valid JSON with the keys listed above. No markdown, no explanations.
- Do NOT include $schema, $defs, $ref, properties, type, or any JSON Schema keywords in your output.

URL: ${url}

JSON Schema (describes the structure your output must follow):
${JSON.stringify(schema, null, 2)}

HTML:
${html}`;

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
  if (!jsonText || jsonText.length < 5) {
    throw new Error(`Empty response for ${url}`);
  }

  const parsed = JSON.parse(jsonText);

  // Validate: reject schema contamination
  if (typeof parsed === 'object' && parsed !== null) {
    const keys = Object.keys(parsed);
    const schemaKeys = ['$schema', '$defs', '$ref', 'definitions'];
    const contaminated = keys.filter(k => schemaKeys.includes(k));
    if (contaminated.length > 0) {
      throw new Error(`Schema contamination in response for ${url}: found keys ${contaminated.join(', ')}`);
    }

    // Validate: reject if top-level keys contain 'properties' and 'type' together (schema echo)
    if (keys.includes('properties') && keys.includes('type')) {
      throw new Error(`Schema echo detected for ${url}: response contains 'properties' and 'type' keys`);
    }

    // Validate: reject improvised keys not in schema
    if (expectedKeys.length > 0) {
      const unexpected = keys.filter(k => !expectedKeys.includes(k));
      if (unexpected.length > 0) {
        throw new Error(`Unexpected keys in response for ${url}: ${unexpected.join(', ')}. Expected: ${expectedKeys.join(', ')}`);
      }
    }
  }

  return {
    content: parsed,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}
