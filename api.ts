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

export async function extractContentFromHtml(
  html: string,
  schema: Record<string, unknown>,
  baseUrl: string,
  url: string
): Promise<unknown> {
  const prompt = `Extract ALL visible content from this webpage HTML. Follow the JSON Schema exactly.

Rules:
- Extract every piece of visible content: text, images (full absolute URLs), links, forms, buttons
- Resolve relative URLs to absolute using base: ${baseUrl}
- For arrays: extract ALL items, not samples
- Output ONLY valid JSON matching the schema. No markdown, no explanations.

URL: ${url}

JSON Schema:
${JSON.stringify(schema, null, 2)}

HTML:
${html}`;

  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const jsonText = extractJSON(text);
  if (!jsonText || jsonText.length < 5) {
    throw new Error(`Empty response for ${url}`);
  }

  return JSON.parse(jsonText);
}
