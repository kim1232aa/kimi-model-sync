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
  isCustomProvider,
  getCandidateModelUrls,
  mergeModelEntry,
} from '../lib/core.js';

import {
  parseToml,
  stringifyToml,
  patchConfigModels,
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

  it('safely skips built-in, managed, and OAuth providers unless explicitly targeted', () => {
    // 1. Managed official account (managed:kimi-code)
    assert.equal(
      isCustomProvider('managed:kimi-code', {
        type: 'kimi',
        base_url: 'https://api.kimi.com/coding/v1',
        api_key: '',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      }),
      false,
    );

    // 2. OAuth authenticated provider
    assert.equal(
      isCustomProvider('github-copilot', {
        base_url: 'https://api.githubcopilot.com',
        oauth: { token: 'gho_123' },
      }),
      false,
    );

    // 3. Provider without base_url
    assert.equal(isCustomProvider('deepseek', { api_key: 'mock-key' }), false);

    // 4. Official built-in provider pointing to official domain
    assert.equal(
      isCustomProvider('kimi', {
        type: 'kimi',
        base_url: 'https://api.moonshot.cn/v1',
        api_key: 'mock-key',
      }),
      false,
    );
    assert.equal(
      isCustomProvider('openai', {
        base_url: 'https://api.openai.com/v1',
        api_key: 'mock-key',
      }),
      false,
    );

    // 5. Official built-in provider redirected to third-party custom relay
    assert.equal(
      isCustomProvider('openai', {
        base_url: 'https://my-relay-proxy.internal/v1',
        api_key: 'mock-key',
      }),
      true,
    );

    // 6. Generic custom relay provider
    assert.equal(
      isCustomProvider('my-custom-gateway', {
        base_url: 'https://relay.custom.io/v1',
        api_key: 'mock-key',
      }),
      true,
    );

    // 7. Explicit sync override
    assert.equal(
      isCustomProvider('managed:kimi-code', {
        base_url: 'https://api.kimi.com/coding/v1',
        sync: true,
      }),
      true,
    );
    assert.equal(
      isCustomProvider('my-custom-gateway', {
        base_url: 'https://relay.custom.io/v1',
        sync: false,
      }),
      false,
    );
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

  it('correctly builds candidate model URLs for endpoints with and without /v1', () => {
    const withoutV1 = getCandidateModelUrls('https://api.gateway.example');
    assert.deepEqual(withoutV1, [
      'https://api.gateway.example/v1/models',
      'https://api.gateway.example/models',
    ]);

    const withV1 = getCandidateModelUrls('https://api.gateway.example/v1');
    assert.deepEqual(withV1, ['https://api.gateway.example/v1/models']);

    const withV1Beta = getCandidateModelUrls('http://internal.host/v1beta/');
    assert.deepEqual(withV1Beta, ['http://internal.host/v1beta/models']);
  });

  it('preserves nested oauth tables, comments, and non-model sections non-destructively', () => {
    const originalToml = `
# System Header Comments
default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

# My Custom Gateway with inline comments
[providers.my-relay]
type = "openai"
base_url = "https://my-relay.com" # no /v1
api_key = "test-token"

[models."my-relay/existing-model"]
provider = "my-relay"
model = "existing-model"
max_context_size = 128000
capabilities = [ "tool_use", "video_in" ]
custom_note = "Do not overwrite"
`;

    const modelsToUpsert = {
      'my-relay/existing-model': {
        provider: 'my-relay',
        model: 'existing-model',
        max_context_size: 1048576,
        max_output_size: 65536,
        capabilities: ['tool_use', 'video_in', 'image_in'],
        custom_note: 'Do not overwrite',
      },
      'my-relay/new-model': {
        provider: 'my-relay',
        model: 'new-model',
        max_context_size: 200000,
        max_output_size: 16384,
        capabilities: ['tool_use'],
      },
    };

    const patched = patchConfigModels(originalToml, modelsToUpsert);

    // 1. Comments preserved
    assert.ok(patched.includes('# System Header Comments'));
    assert.ok(patched.includes('# My Custom Gateway with inline comments'));
    assert.ok(patched.includes('# no /v1'));

    // 2. Nested oauth table intact
    assert.ok(patched.includes('[providers."managed:kimi-code".oauth]'));
    assert.ok(patched.includes('storage = "file"'));
    assert.ok(patched.includes('key = "oauth/kimi-code"'));

    // 3. Updated model replaced with new limits and preserved custom_note
    assert.ok(patched.includes('max_context_size = 1048576'));
    assert.ok(patched.includes('custom_note = "Do not overwrite"'));

    // 4. New model appended
    assert.ok(patched.includes('[models."my-relay/new-model"]'));
  });

  it('merges existing model entries preserving custom capabilities and efforts', () => {
    const existing = {
      provider: 'my-relay',
      model: 'custom-opus',
      max_context_size: 100000,
      capabilities: ['tool_use', 'video_in'],
      support_efforts: ['minimal', 'high', 'xhigh'],
      default_effort: 'high',
      off_effort: 'off',
      user_annotation: 'special',
    };

    const generated = {
      provider: 'my-relay',
      model: 'custom-opus',
      max_context_size: 200000,
      max_output_size: 64000,
      capabilities: ['tool_use', 'image_in', 'thinking'],
      support_efforts: ['low', 'medium', 'high', 'max'],
    };

    const merged = mergeModelEntry(existing, generated);

    // Preserved video_in alongside newly detected image_in and thinking
    assert.ok(merged.capabilities.includes('video_in'));
    assert.ok(merged.capabilities.includes('image_in'));
    assert.ok(merged.capabilities.includes('thinking'));
    assert.ok(merged.capabilities.includes('tool_use'));

    // Preserved custom reasoning efforts like xhigh and minimal
    assert.ok(merged.support_efforts.includes('xhigh'));
    assert.ok(merged.support_efforts.includes('minimal'));
    assert.equal(merged.default_effort, 'high');
    assert.equal(merged.off_effort, 'off');

    // Preserved user_annotation
    assert.equal(merged.user_annotation, 'special');
  });

  it('supports dry-run preview mode without modifying disk or creating backup', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-dryrun-'));
    const configPath = path.join(tempDir, 'config.toml');

    const initialToml = `
default_model = "test-provider/existing-model"

[providers.test-provider]
type = "openai"
base_url = "https://mock.gateway.example"
api_key = "mock-secret"
`;
    fs.writeFileSync(configPath, initialToml, 'utf8');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      // url might be /v1/models because of candidate testing
      if (url.toString().includes('/models')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [{ id: 'gpt-5.6-luna' }],
          }),
        };
      }
      return originalFetch(url);
    };

    try {
      const res = await syncKimiModels({
        configPath,
        dryRun: true,
        logger: { warn: () => {}, error: () => {} },
      });

      assert.equal(res.success, true);
      assert.equal(res.dryRun, true);
      assert.equal(res.diffSummary.length, 1);
      assert.equal(res.diffSummary[0].action, 'add');

      // Verify file was NOT modified in dry-run
      const currentToml = fs.readFileSync(configPath, 'utf8');
      assert.equal(currentToml, initialToml);
      assert.equal(fs.existsSync(`${configPath}.bak`), false);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
