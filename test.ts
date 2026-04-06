import 'dotenv/config';
import { extractContentFromHtml } from './api.js';

// Quick smoke test for direct API call
console.log('Testing direct API call...');
console.log('Model:', process.env.LLM_MODEL || '(default)');
console.log('Base URL:', process.env.ANTHROPIC_BASE_URL || '(default)');

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    title: { type: 'string' },
    greeting: { type: 'string' },
  },
};

const html = '<h1>Hello World</h1><p>Welcome to the test page.</p>';

try {
  const result = await extractContentFromHtml(html, schema, 'https://example.com', '/test');
  console.log('Result:', JSON.stringify(result, null, 2));
  console.log('done');
} catch (error) {
  console.error('Failed:', error);
  process.exit(1);
}
