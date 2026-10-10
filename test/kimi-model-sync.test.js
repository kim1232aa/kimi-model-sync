import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  generateLookupCandidates,
  isNonChatModel,
  buildKimiModel,
  pickDevRepresentative,
} from '../lib/core.js';

import {
  parseToml,
  stringifyToml,
  writeConfigAtomic,
} from '../lib/kimi-toml.js';

import { syncKimiModels } from '../lib/index.js';

describe('kimi-model-sync unit tests', () => {
  it('correctly strips gateway routing brackets and qualifiers', () => {
    const candidates = generateLookupCandidates('cx/gpt-6-astra[1m]-review');
    assert.ok(candidates.includes('gpt-6-astra'));
    assert.ok(candidates.includes('cx/gpt-6-astra[1m]-review'));
  });

  it('filters out non-chat models', () => {
    assert.equal(isNonChatModel('text-embedding-3-small'), true);
    assert.equal(isNonChatModel('whisper-1'), true);
    assert.equal(isNonChatModel('dall-e-3'), true);
    assert.equal(isNonChatModel('bge-reranker-large'), true);
    assert.equal(isNonChatModel('gpt-5.6-luna'), false);
    assert.equal(isNonChatModel('claude-3-7-sonnet'), false);
  });

  it('restores truncated context size and maps Kimi Code capabilities', () => {
    const rawGatewayModel = {
      id: 'custom/gpt-6-astra',
      capabilities: {
        contextWindow: 272000, // Gateway truncated cutoff ceiling
        maxOutput: 64000,
        vision: true,
        reasoning: true,
      },
    };

    const devEntry = {
      name: 'GPT-6 Astra',
      limit: {
        context: 1050000,
        output: 128000,
      },
      modalities: {
        input: ['text', 'image'],
      },
      reasoning: true,
    };

    const result = buildKimiModel('custom-provider', 'gpt-6-astra', rawGatewayModel, devEntry);

    assert.equal(result.provider, 'custom-provider');
    assert.equal(result.model, 'gpt-6-astra');
    // Math.max restores 1,050,000 against 272,000 truncation
    assert.equal(result.max_context_size, 1050000);
    assert.equal(result.max_output_size, 128000);
    // Kimi Code capabilities
    assert.ok(result.capabilities.includes('image_in'));
    assert.ok(result.capabilities.includes('thinking'));
    assert.ok(result.capabilities.includes('tool_use'));
    assert.deepEqual(result.support_efforts, ['low', 'medium', 'high', 'max']);
    assert.equal(result.default_effort, 'medium');
  });

  it('resolves representative provider during tie-breaking', () => {
    const candidates = [
      { providerId: 'relay-router', entry: { name: 'Relay Model' } },
      { providerId: 'openai', entry: { name: 'Official OpenAI Model' } },
    ];
    const picked = pickDevRepresentative(candidates);
    assert.equal(picked.name, 'Official OpenAI Model');
  });

  it('parses and serializes TOML correctly preserving structure', () => {
    const sampleToml = `
default_model = "kimi-code/k3"

[providers.test-gw]
type = "openai"
base_url = "https://example.com/v1"
api_key = "test-token"

[models."test-gw/k3"]
provider = "test-gw"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "image_in", "tool_use" ]
`;

    const parsed = parseToml(sampleToml);
    assert.equal(parsed.default_model, 'kimi-code/k3');
    assert.equal(parsed.providers['test-gw'].base_url, 'https://example.com/v1');
    assert.equal(parsed.models['test-gw/k3'].max_context_size, 1048576);
    assert.deepEqual(parsed.models['test-gw/k3'].capabilities, ['thinking', 'image_in', 'tool_use']);

    const regenerated = stringifyToml(parsed);
    assert.ok(regenerated.includes('[providers.test-gw]'));
    assert.ok(regenerated.includes('[models."test-gw/k3"]'));
  });

  it('executes end-to-end sync workflow using isolated temp directory', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-test-'));
    const configPath = path.join(tempDir, 'config.toml');

    const initialToml = `
default_model = "test-provider/existing-model"

[providers.test-provider]
type = "openai"
base_url = "https://mock.gateway.example/v1"
api_key = "mock-secret"
`;
    fs.writeFileSync(configPath, initialToml, 'utf8');

    // Create a local mock gateway using global fetch stubbing
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.toString().includes('/models')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [
              { id: 'gpt-5.6-luna', capabilities: { contextWindow: 200000, vision: true, reasoning: true } },
              { id: 'text-embedding-3-small' },
            ],
          }),
        };
      }
      return originalFetch(url);
    };

    try {
      const res = await syncKimiModels({
        configPath,
        logger: { warn: () => {}, error: () => {} },
      });

      assert.equal(res.success, true);
      assert.equal(res.results.length, 1);
      assert.equal(res.results[0].added, 1); // Only gpt-5.6-luna (embedding is filtered out)

      // Verify backup was generated
      assert.ok(fs.existsSync(`${configPath}.bak`));

      // Verify written config.toml
      const writtenToml = fs.readFileSync(configPath, 'utf8');
      const updatedConfig = parseToml(writtenToml);

      assert.ok(updatedConfig.models['test-provider/gpt-5.6-luna']);
      assert.equal(updatedConfig.models['test-provider/gpt-5.6-luna'].provider, 'test-provider');
      assert.ok(updatedConfig.models['test-provider/gpt-5.6-luna'].capabilities.includes('thinking'));
      assert.ok(updatedConfig.models['test-provider/gpt-5.6-luna'].capabilities.includes('image_in'));
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
