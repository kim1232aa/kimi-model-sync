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
  extractEffortsFromReasoningOptions,
  lookupModelsDev,
} from '../lib/core.js';

import {
  parseToml,
  stringifyToml,
  patchConfigModels,
  writeConfigAtomic,
  parseTableHeader,
  parseModelHeader,
  validatePatchedConfig,
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
    assert.equal(isNonChatModel('relay/kling/kling-video-o1'), true);
    assert.equal(isNonChatModel('relay/kling/kling-v3'), true);
    assert.equal(isNonChatModel('relay/gemini-3-pro-image'), true);
    assert.equal(isNonChatModel('gemini-3.1-flash-image'), true);
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
    // models.dev gave no effort levels: nothing is invented
    assert.equal(result.support_efforts, undefined);
    assert.equal(result.default_effort, undefined);
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


describe('regression: config.toml must stay valid after sync', () => {
  const BASE = `# header comment
default_model = "Google/gemini-3.8-flash"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

[providers.Google]
type = "openai"
base_url = "https://gw.example/v1"
api_key = "k"

[thinking]
enabled = true
effort = "high"

[models."Google/gemini-3.8-flash"]
provider = "Google"
model = "gemini-3.8-flash"
max_context_size = 100000
capabilities = [ "tool_use" ]

# my pinned limits
[models."Google/gemini-3.8-flash".overrides]
max_context_size = 131072
display_name = "Gemini (mine)"

[models."Google/untouched"]
provider = "Google"
model = "untouched"
max_context_size = 1000

[models."Google/untouched".overrides]
display_name = "keep me"

[secondary_model]
default_model = "Google/gemini-3.8-flash"
`;

  const devReasoning = [
    { type: 'effort', values: ['none', 'default', 'low', 'medium', 'high', ''] },
    { type: 'toggle' },
    { type: 'budget_tokens' },
  ];

  it('extractEffortsFromReasoningOptions returns ordered string efforts, never objects', () => {
    const r = extractEffortsFromReasoningOptions(devReasoning);
    assert.deepEqual(r.efforts, ['low', 'medium', 'high']);
    assert.equal(r.canDisable, true);
    assert.equal(extractEffortsFromReasoningOptions([{ type: 'toggle' }]), null);
    assert.equal(extractEffortsFromReasoningOptions(undefined), null);
    assert.equal(extractEffortsFromReasoningOptions({ foo: 1 }), null);
  });

  it('buildKimiModel writes support_efforts as plain strings from models.dev reasoning_options', () => {
    const m = buildKimiModel('Google', 'gemini-3.8-flash', { capabilities: { reasoning: true } }, {
      reasoning: true,
      limit: { context: 1048576, output: 65536 },
      reasoning_options: devReasoning,
    });
    assert.deepEqual(m.support_efforts, ['low', 'medium', 'high']);
    assert.equal(m.default_effort, 'medium');
    assert.equal(m.off_effort, 'none');
    assert.ok(m.support_efforts.every((e) => typeof e === 'string'));

    // toggle/budget-only reasoning model: do not invent graded efforts
    const t = buildKimiModel('Google', 'x-thinking', { capabilities: { reasoning: true } }, {
      reasoning: true,
      reasoning_options: [{ type: 'toggle' }],
    });
    assert.equal(t.support_efforts, undefined);
  });

  it('mergeModelEntry heals support_efforts corrupted by older releases and keeps overrides', () => {
    const merged = mergeModelEntry(
      {
        support_efforts: [{ type: 'effort', values: ['low'] }, { type: 'toggle' }, 'xhigh'],
        overrides: { max_context_size: 131072 },
      },
      { support_efforts: ['low', 'high'], overrides: undefined },
    );
    assert.deepEqual(merged.support_efforts, ['low', 'high', 'xhigh']);
    assert.deepEqual(merged.overrides, { max_context_size: 131072 });

    const allBad = mergeModelEntry({ support_efforts: [{ type: 'toggle' }] }, { support_efforts: [] });
    assert.equal(allBad.support_efforts, undefined);
  });

  it('parses table headers incl. sub-tables, quoted ] . # and trailing comments', () => {
    assert.deepEqual(parseTableHeader('[models."a/b"]'), { isArray: false, parts: ['models', 'a/b'] });
    assert.deepEqual(parseTableHeader('[ models . "a/b" . overrides ]  # c'), {
      isArray: false,
      parts: ['models', 'a/b', 'overrides'],
    });
    assert.deepEqual(parseTableHeader('[models."weird]#.name[1m]"]').parts, ['models', 'weird]#.name[1m]']);
    assert.deepEqual(parseTableHeader("[models.'single.q']").parts, ['models', 'single.q']);
    assert.equal(parseTableHeader('[[permission.rules]]').isArray, true);
    assert.equal(parseTableHeader('key = "[models.x]"'), null);
    assert.equal(parseTableHeader('# [models.x]'), null);
    assert.deepEqual(parseModelHeader('[models."a/b".overrides]'), {
      modelKey: 'a/b',
      isSubTable: true,
      subPath: ['overrides'],
    });
    assert.equal(parseModelHeader('[providers.x]'), null);
  });

  it('patchConfigModels keeps .overrides exactly once and emits valid TOML', () => {
    const original = parseToml(BASE);
    const merged = mergeModelEntry(
      original.models['Google/gemini-3.8-flash'],
      buildKimiModel('Google', 'gemini-3.8-flash', { capabilities: { reasoning: true } }, {
        reasoning: true,
        limit: { context: 1048576, output: 65536 },
        reasoning_options: devReasoning,
      }),
    );
    const upsert = {
      'Google/gemini-3.8-flash': merged,
      'Google/brand-new': buildKimiModel('Google', 'brand-new', {}, undefined),
    };
    const patched = patchConfigModels(BASE, upsert);

    const headers = patched.match(/^\s*\[\[?[^\]]+\]\]?\s*$/gm).map((h) => h.trim());
    assert.equal(new Set(headers).size, headers.length, `duplicate headers: ${headers.join(' | ')}`);
    assert.ok(!patched.includes('support_efforts]'), 'support_efforts must not become a table');

    const parsed = parseToml(patched); // must not throw
    const m = parsed.models['Google/gemini-3.8-flash'];
    assert.deepEqual(m.support_efforts, ['low', 'medium', 'high']);
    assert.equal(m.max_context_size, 1048576);
    assert.deepEqual({ ...m.overrides }, { max_context_size: 131072, display_name: 'Gemini (mine)' });
    assert.ok(parsed.models['Google/brand-new']);

    // everything else untouched
    assert.deepEqual(parsed.models['Google/untouched'], original.models['Google/untouched']);
    assert.deepEqual(parsed.providers['managed:kimi-code'], original.providers['managed:kimi-code']);
    assert.deepEqual(parsed.thinking, original.thinking);
    assert.deepEqual(parsed.secondary_model, original.secondary_model);
    assert.ok(patched.startsWith('# header comment'));
    assert.ok(patched.includes('[models."Google/untouched".overrides]'));
    validatePatchedConfig(original, patched, upsert);
  });

  it('patchConfigModels is a no-op without upserts and idempotent on a second run', () => {
    assert.equal(patchConfigModels(BASE, {}), BASE);
    const original = parseToml(BASE);
    const upsert = { 'Google/new-one': buildKimiModel('Google', 'new-one', {}, undefined) };
    const once = patchConfigModels(BASE, upsert);
    const twice = patchConfigModels(once, { 'Google/new-one': parseToml(once).models['Google/new-one'] });
    assert.deepEqual(parseToml(twice), parseToml(once));
    assert.deepEqual(parseToml(once).models['Google/untouched'], original.models['Google/untouched']);
  });

  it('handles models whose alias contains dots/brackets and array-of-tables sections', () => {
    const text = `[[permission.rules]]
decision = "allow"
pattern = "Read"

[models."gpt-4.1[1m]"]
provider = "p"
model = "gpt-4.1"
max_context_size = 10

[models."gpt-4.1[1m]".overrides]
display_name = "x"

[[hooks]]
event = "PreToolUse"
command = "echo hi"
`;
    const upsert = {
      'gpt-4.1[1m]': mergeModelEntry(parseToml(text).models['gpt-4.1[1m]'], {
        provider: 'p', model: 'gpt-4.1', max_context_size: 1050000, capabilities: ['tool_use'],
      }),
    };
    const patched = patchConfigModels(text, upsert);
    const parsed = parseToml(patched);
    assert.equal(parsed.models['gpt-4.1[1m]'].max_context_size, 1050000);
    assert.equal(parsed.models['gpt-4.1[1m]'].overrides.display_name, 'x');
    assert.equal(parsed.permission.rules.length, 1);
    assert.equal(parsed.hooks.length, 1);
    assert.equal(patched.match(/^\[\[hooks\]\]$/gm).length, 1);
  });

  it('validatePatchedConfig refuses invalid TOML and unexpected changes', () => {
    const original = parseToml(BASE);
    assert.throws(() => validatePatchedConfig(original, BASE + '\n[models."Google/untouched".overrides]\nx = 1\n', {}), /invalid/);
    assert.throws(
      () => validatePatchedConfig(original, BASE.replace('effort = "high"', 'effort = "low"'), {}),
      /top-level "thinking"/,
    );
    assert.throws(
      () => validatePatchedConfig(original, BASE.replace('model = "untouched"', 'model = "other"'), {}),
      /untouched model/,
    );
  });

  it('end-to-end: large gateway list over an existing config with overrides stays valid, dry-run == real', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-e2e-'));
    const configPath = path.join(tempDir, 'config.toml');
    const cacheDir = path.join(tempDir, 'models-dev-cache.json');
    const text = BASE.replace('https://gw.example/v1', 'https://gw.example/v1');
    fs.writeFileSync(configPath, text);
    fs.writeFileSync(
      cacheDir,
      JSON.stringify({
        google: {
          models: {
            'gemini-3.8-flash': {
              id: 'gemini-3.8-flash', reasoning: true,
              limit: { context: 1048576, output: 65536 },
              modalities: { input: ['text', 'image'] },
              reasoning_options: devReasoning,
            },
          },
        },
      }),
    );

    const remote = [{ id: 'gemini-3.8-flash' }];
    for (let i = 0; i < 300; i++) remote.push({ id: `vendor/model-${i}-thinking` });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('https://gw.example/')) {
        return new Response(JSON.stringify({ data: remote }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const opts = { configPath, modelsDevCachePath: cacheDir, logger: { warn() {}, error() {}, log() {} } };
      const before = fs.readFileSync(configPath, 'utf8');
      const dry = await syncKimiModels({ ...opts, dryRun: true });
      assert.equal(dry.wrote, false);
      assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'dry-run must not touch the file');

      const real = await syncKimiModels(opts);
      assert.equal(real.wrote, true);
      assert.equal(real.diffSummary.length, dry.diffSummary.length);

      const parsed = parseToml(fs.readFileSync(configPath, 'utf8')); // must not throw
      assert.ok(Object.keys(parsed.models).length >= 300);
      assert.deepEqual({ ...parsed.models['Google/gemini-3.8-flash'].overrides }, { max_context_size: 131072, display_name: 'Gemini (mine)' });
      assert.deepEqual(parsed.models['Google/gemini-3.8-flash'].support_efforts, ['low', 'medium', 'high']);
      assert.deepEqual({ ...parsed.providers['managed:kimi-code'].oauth }, { storage: 'file', key: 'oauth/kimi-code' });
      for (const m of Object.values(parsed.models)) {
        if (m.support_efforts !== undefined) {
          assert.ok(Array.isArray(m.support_efforts) && m.support_efforts.every((e) => typeof e === 'string'));
        }
      }

      // second run changes nothing
      const again = await syncKimiModels(opts);
      assert.equal(again.wrote, false);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

it('lookupModelsDev does not borrow another model for unknown ids', () => {
  const catalog = { openai: { models: { 'gpt-5.4': { id: 'gpt-5.4', name: 'GPT-5.4', limit: { context: 400000, output: 128000 } } } } };
  assert.equal(lookupModelsDev(catalog, 'gpt-6'), null);
  assert.equal(lookupModelsDev(catalog, 'gpt-6.2'), null);
  assert.equal(lookupModelsDev(catalog, 'gpt-5.4').name, 'GPT-5.4');
});

it('buildKimiModel never generates display_name', () => {
  const m = buildKimiModel('p', 'cc/claude-sonnet-5-5', { id: 'cc/claude-sonnet-5-5', name: 'Gateway Name' }, { name: 'Claude Sonnet 5.5', limit: { context: 1000000, output: 64000 } }, {}, null);
  assert.equal('display_name' in m, false);
});

it('never guesses capabilities from the model id', () => {
  for (const id of ['gpt-6-codex', 'relay/eco-gpt-6', 'relay/kling/kling-video-o1', 'grok-4.7', 'kimi-k3', 'deepseek-r1', 'claude-4-x', 'gemini-9']) {
    const m = buildKimiModel('p', id, {}, undefined, {}, null);
    assert.deepEqual(m.capabilities, ['tool_use'], id);
    assert.equal(m.support_efforts, undefined, id);
    assert.equal(m.default_effort, undefined, id);
    assert.equal(m.max_context_size, 128000, id);
    assert.equal(m.max_output_size, 16384, id);
  }
  // explicit signals are still honoured
  const m = buildKimiModel('p', 'x', { capabilities: { vision: true, reasoning: true } }, undefined, {}, null);
  assert.deepEqual(m.capabilities, ['tool_use', 'image_in', 'thinking']);
  assert.equal(m.support_efforts, undefined);
  // never always_thinking, even for ids that used to match
  const g = buildKimiModel('p', 'grok-4.7', { capabilities: { reasoning: true } }, { reasoning: true }, {}, null);
  assert.equal(g.capabilities.includes('always_thinking'), false);
});

it('generateLookupCandidates strips trailing date snapshots', () => {
  const c = generateLookupCandidates('Relay-Plan/doubao-1-5-thinking-pro-250415');
  assert.ok(c.includes('doubao-1-5-thinking-pro'));
  assert.ok(c.includes('doubao-1.5-thinking-pro'));
  assert.ok(generateLookupCandidates('gpt-5.4-2026-03-05').includes('gpt-5.4'));
  assert.ok(generateLookupCandidates('gpt-5-20250807').includes('gpt-5'));
  // not a date: model version numbers must be left alone
  assert.equal(generateLookupCandidates('qwen3-235b').includes('qwen3'), false);
});

