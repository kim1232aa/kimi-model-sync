/**
 * Core normalization and specification logic for Kimi Code models.
 */

const NON_CHAT_ID_PATTERNS = [
  /(?:^|[-_/])(?:embed|embedding|rerank|reranker)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:tts|whisper|speech|audio|voice|transcribe|transcription|realtime)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:dall-e|midjourney|flux|stable-diffusion|sdxl|imagen|gpt-image|seedream|seededit|seedance|grok-imagine)(?:$|[-_/])/i,
  // generation models: dedicated vendors/families, or an id that ENDS in image/video
  // (keeps chat models such as qwen3-vl-image-understanding / kimi-k2-video-chat)
  /(?:^|[-_/])(?:kling|sora|veo|i2v|t2v|flf2v|r2v)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:image|video)(?:-(?:preview|generation|gen|exp|\d[\w.]*))?$/i,
  /(?:^|[-_/])(?:moderation|guardrail|safety)(?:$|[-_/])/i,
];

export function isNonChatModel(id) {
  return NON_CHAT_ID_PATTERNS.some((pat) => pat.test(id));
}

export function parsePositiveNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

// -250415 / -20250415 / -2025-04-15 / -0613 (MMDD)
const DATE_SNAPSHOT_RE = /-(?:(?:\d{2}|\d{4})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|\d{4}-\d{2}-\d{2}|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/;
const VARIANT_SUFFIX_RE = /-(?:high|low|medium|tiered|extra|thinking|agent)$/i;
// 3-2 -> 3.2, 2-5 -> 2.5 (one or two digit components followed by - / letter / end)
const VERSION_DASH_RE = /(\d)-(\d{1,2})(?=-|[a-z]|$)/gi;

export function generateLookupCandidates(id) {
  const candidates = new Set();
  const raw = id.trim();
  candidates.add(raw);

  // 1. Strip bracket annotations like [1m], [128k], [tier-1]
  const strippedBrackets = raw.replace(/\[[^\]]+\]/g, '').trim();
  if (strippedBrackets && strippedBrackets !== raw) {
    candidates.add(strippedBrackets);
  }

  // 2. Base ID from stripped brackets
  const base = strippedBrackets || raw;

  // 3. Strip route/task prefixes (e.g. "cx/gpt-5.5" -> "gpt-5.5")
  const slashIdx = base.lastIndexOf('/');
  const noPrefix = slashIdx >= 0 ? base.slice(slashIdx + 1) : base;
  candidates.add(noPrefix);

  // 4. Strip colon tags (e.g. ":free", ":thinking")
  const colonIdx = noPrefix.indexOf(':');
  const noTag = colonIdx >= 0 ? noPrefix.slice(0, colonIdx) : noPrefix;
  candidates.add(noTag);

  // 5. Strip common routing / marketing qualifiers
  const strippedQualifiers = noTag
    .replace(/-(?:openai-compact|compact|review|fast|wm|free)$/i, '')
    .trim();
  candidates.add(strippedQualifiers);

  // 6. Strip thinking & tier variants repeatedly (e.g. "-extra-low" -> "-extra" -> base)
  let strippedVariants = strippedQualifiers;
  for (let i = 0; i < 3; i++) {
    const next = strippedVariants.replace(VARIANT_SUFFIX_RE, '').trim();
    if (next === strippedVariants) break;
    strippedVariants = next;
    candidates.add(strippedVariants);
  }
  candidates.add(strippedVariants);

  // 6b. Strip a trailing date snapshot (-250415, -20250415, -2025-04-15) so that
  //     "doubao-1-5-thinking-pro-250415" can match models.dev's "doubao-1.5-thinking-pro".
  for (const c of Array.from(candidates)) {
    const noDate = c.replace(DATE_SNAPSHOT_RE, '');
    if (noDate && noDate !== c) candidates.add(noDate);
  }

  // 7. Preview and version transformations
  for (const c of Array.from(candidates)) {
    if (c.includes('-preview')) {
      candidates.add(c.replace('-preview', ''));
    } else {
      candidates.add(`${c}-preview`);
    }

    if (/-(\d+)-(\d+)/.test(c)) {
      candidates.add(c.replace(/-(\d+)-(\d+)/, '-$1.$2'));
    }
    if (VERSION_DASH_RE.test(c)) {
      VERSION_DASH_RE.lastIndex = 0;
      candidates.add(c.replace(VERSION_DASH_RE, '$1.$2'));
    }
    VERSION_DASH_RE.lastIndex = 0;
    if (/-(\d+)\.(\d+)/.test(c)) {
      candidates.add(c.replace(/-(\d+)\.(\d+)/, '-$1-$2'));
    }
  }

  return Array.from(candidates).filter((c) => c && c.length > 0);
}

const PRIMARY_PROVIDERS = new Set(['openai', 'google', 'anthropic', 'deepseek', 'xai', 'meta', 'mistral', 'moonshotai', 'zhipu']);

export function pickDevRepresentative(candidates) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].entry;

  const scored = candidates.map((item) => {
    let score = 0;
    const provider = item.providerId.toLowerCase();
    if (PRIMARY_PROVIDERS.has(provider)) {
      score += 100;
    }
    if (provider.includes('router') || provider.includes('relay') || provider.includes('free')) {
      score -= 50;
    }
    return { entry: item.entry, score, providerId: item.providerId };
  });

  scored.sort((a, b) => b.score - a.score || a.providerId.localeCompare(b.providerId));
  return scored[0].entry;
}

const catalogIndexCache = new WeakMap();

function getCatalogIndex(catalog) {
  let idx = catalogIndexCache.get(catalog);
  if (idx) return idx;
  idx = { exact: new Map(), lower: new Map(), segment: new Map() };
  const push = (map, key, item) => {
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  };
  for (const [providerId, providerData] of Object.entries(catalog)) {
    const models = providerData?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelId, entry] of Object.entries(models)) {
      const item = { providerId, modelId, entry };
      push(idx.exact, modelId, item);
      push(idx.lower, modelId.toLowerCase(), item);
      const slash = modelId.lastIndexOf('/');
      if (slash >= 0) push(idx.segment, modelId.slice(slash + 1).toLowerCase(), item);
    }
  }
  catalogIndexCache.set(catalog, idx);
  return idx;
}

export function lookupModelsDev(catalog, id) {
  if (!catalog || typeof catalog !== 'object') return null;

  const candidates = generateLookupCandidates(id);

  const index = getCatalogIndex(catalog);

  // 1. Exact id, then case-insensitive id, then provider-style key whose last
  //    path segment equals the candidate ("minimax/minimax-h3" for "minimax-h3").
  for (const pass of ['exact', 'lower', 'segment']) {
    for (const cand of candidates) {
      const hits = index[pass].get(pass === 'exact' ? cand : cand.toLowerCase());
      if (hits && hits.length > 0) return pickDevRepresentative(hits);
    }
  }

  // No guessing: an id with no models.dev match must not borrow another model's
  // name/limits (a former "gpt-6* -> gpt-5.4" fallback mislabelled unknown models).
  return null;
}

/**
 * Determine candidate URLs for fetching models from a gateway.
 * Many gateways do not declare /v1 in base_url (e.g. https://domain.com),
 * while OpenAI compatible endpoints expose /v1/models.
 */
export function getCandidateModelUrls(baseUrl) {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  const candidates = [];

  if (/\/v\d+(?:beta)?$/i.test(clean)) {
    // URL already has version suffix like /v1 or /v1beta
    candidates.push(`${clean}/models`);
  } else {
    // URL without version suffix: try /v1/models first, fallback to /models
    candidates.push(`${clean}/v1/models`);
    candidates.push(`${clean}/models`);
  }
  return candidates;
}

export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Read the thinking-effort levels from a models.dev `reasoning_options` value.
 * models.dev shape: [{ type: 'effort', values: ['none','low','high'] }, { type: 'toggle' }, { type: 'budget_tokens' }]
 * Returns { efforts: string[] (ordered, Kimi-valid), canDisable: boolean (values include 'none') },
 * or null when models.dev does not describe graded effort levels.
 */
export function extractEffortsFromReasoningOptions(reasoningOptions) {
  if (!Array.isArray(reasoningOptions)) return null;
  const effortOpt = reasoningOptions.find(
    (o) => o && typeof o === 'object' && o.type === 'effort' && Array.isArray(o.values),
  );
  if (!effortOpt) return null;
  const values = effortOpt.values
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim().toLowerCase());
  const efforts = EFFORT_ORDER.filter((e) => values.includes(e));
  if (efforts.length === 0) return null;
  return { efforts, canDisable: values.includes('none') };
}

/**
 * Merge newly computed model specifications with existing user configurations,
 * preserving user-defined fields (e.g. video_in, custom notes, custom overrides)
 * and avoiding clobbering fine-tuned settings.
 */
export function mergeModelEntry(existingModel, generatedModel) {
  if (!existingModel || typeof existingModel !== 'object') {
    return generatedModel;
  }

  const merged = { ...existingModel, ...generatedModel };

  // 1. Preserve capabilities union (do not drop user-added video_in, audio_in, etc.)
  const existingCaps = Array.isArray(existingModel.capabilities) ? existingModel.capabilities : [];
  const generatedCaps = Array.isArray(generatedModel.capabilities) ? generatedModel.capabilities : [];
  const capsSet = new Set([...existingCaps, ...generatedCaps]);
  merged.capabilities = Array.from(capsSet);

  // 2. Preserve and merge reasoning efforts (preserve xhigh, minimal, etc.).
  //    support_efforts must be array<string> for Kimi Code: drop anything else
  //    (older releases wrote models.dev option objects here, which TOML emits as
  //    array-of-tables and makes the whole config.toml unloadable).
  if (generatedModel.support_efforts || existingModel.support_efforts) {
    const asStrings = (v) =>
      (Array.isArray(v) ? v : []).filter((e) => typeof e === 'string' && e.trim() !== '').map((e) => e.trim());
    const mergedEffortsSet = new Set([
      ...asStrings(existingModel.support_efforts),
      ...asStrings(generatedModel.support_efforts),
    ]);
    const ordered = EFFORT_ORDER.filter((e) => mergedEffortsSet.has(e));
    const extras = Array.from(mergedEffortsSet).filter((e) => !EFFORT_ORDER.includes(e));
    const result = [...ordered, ...extras];
    if (result.length > 0) {
      merged.support_efforts = result;
    } else {
      delete merged.support_efforts;
    }
  }

  // 2b. Sub-tables owned by the user ([models."x".overrides]) survive refreshes:
  //     user values win, generated values only fill gaps.
  if (existingModel.overrides && typeof existingModel.overrides === 'object' && !Array.isArray(existingModel.overrides)) {
    merged.overrides = { ...(generatedModel.overrides || {}), ...existingModel.overrides };
  }

  // 3. Keep user-defined default_effort and off_effort if already specified
  if (typeof existingModel.default_effort === 'string' && existingModel.default_effort) {
    merged.default_effort = existingModel.default_effort;
  }
  if (typeof existingModel.off_effort === 'string' && existingModel.off_effort) {
    merged.off_effort = existingModel.off_effort;
  }

  return merged;
}

/**
 * Build Kimi Code standard model table entry.
 */
export function buildKimiModel(providerId, id, rawModel = {}, devEntry, override = {}, existingModel = null) {
  const caps = rawModel.capabilities || {};

  // Context window & max output: use Math.max to avoid gateway cutoff (e.g. 272k / 128k)
  const rawContext = parsePositiveNumber(caps.contextWindow || rawModel.context_window || rawModel.contextWindow);
  const devContext = parsePositiveNumber(devEntry?.limit?.context);
  let contextSize = Math.max(rawContext ?? 0, devContext ?? 0);
  if (contextSize === 0) contextSize = 128000;

  const rawMaxOutput = parsePositiveNumber(caps.maxOutput || rawModel.max_output_tokens || rawModel.maxOutput);
  const devMaxOutput = parsePositiveNumber(devEntry?.limit?.output);
  let outputSize = Math.max(rawMaxOutput ?? 0, devMaxOutput ?? 0);
  if (outputSize === 0) outputSize = 16384;

  // Vision resolution: override > raw=true > dev=true > raw=false > false (never guessed from the id)
  let vision = false;
  if (override?.vision !== undefined) {
    vision = Boolean(override.vision);
  } else if (caps.vision === true) {
    vision = true;
  } else if (devEntry?.modalities?.input?.includes('image')) {
    vision = true;
  } else if (caps.vision === false) {
    vision = false;
  }

  // Reasoning resolution
  let reasoning = false;
  if (override?.reasoning !== undefined) {
    reasoning = Boolean(override.reasoning);
  } else if (
    caps.reasoning === true ||
    devEntry?.reasoning === true
  ) {
    reasoning = true;
  } else if (caps.reasoning === false) {
    reasoning = false;
  } else if (devEntry?.reasoning === false) {
    reasoning = false;
  }

  // Capabilities array in Kimi Code format
  const capabilities = ['tool_use'];
  if (vision) {
    capabilities.push('image_in');
  }
  if (reasoning) {
    capabilities.push('thinking');
  }

  const modelEntry = {
    provider: providerId,
    model: id,
    max_context_size: contextSize,
    max_output_size: outputSize,
    capabilities,
  };

  // display_name is intentionally never generated (optional Kimi field; the user does not want synced display names).

  // Reasoning efforts support for Kimi Code (support_efforts is array<string>).
  // - models.dev lists graded efforts  -> use exactly those (+ off_effort only if it allows 'none')
  // - models.dev describes the model but without graded efforts (toggle / budget_tokens only)
  //   -> do not invent effort levels
  // - nothing known -> write nothing (no invented effort ladder)
  if (reasoning) {
    const devOptions = devEntry?.reasoning_options;
    const parsedEfforts = extractEffortsFromReasoningOptions(devOptions);
    if (parsedEfforts) {
      modelEntry.support_efforts = parsedEfforts.efforts;
      modelEntry.default_effort = parsedEfforts.efforts.includes('medium')
        ? 'medium'
        : parsedEfforts.efforts.includes('high')
          ? 'high'
          : parsedEfforts.efforts[0];
      if (parsedEfforts.canDisable) modelEntry.off_effort = 'none';
    }
  }

  if (existingModel) {
    return mergeModelEntry(existingModel, modelEntry);
  }

  return modelEntry;
}

export const BUILT_IN_PROVIDERS = new Set([
  'kimi',
  'moonshot',
  'moonshotai',
  'openai',
  'anthropic',
  'google',
  'google-genai',
  'vertexai',
  'deepseek',
  'groq',
  'cerebras',
  'mistral',
  'cohere',
  'github-copilot',
  'azure',
]);

export const DEFAULT_BUILTIN_DOMAINS = [
  'api.kimi.com',
  'api.kimi.ai',
  'api.moonshot.cn',
  'api.moonshot.ai',
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'googleapis.com',
  'api.deepseek.com',
  'api.mistral.ai',
  'api.groq.com',
  'api.cerebras.ai',
  'openai.azure.com',
];

/**
 * Determine whether a provider is an eligible custom/relay gateway provider,
 * explicitly avoiding built-in providers, managed accounts, and official endpoints.
 */
export function isCustomProvider(providerId, providerConfig) {
  if (!providerConfig || typeof providerConfig !== 'object') return false;

  // Explicit user override
  if (providerConfig.sync === true) return true;
  if (providerConfig.sync === false) return false;

  // Must have a valid base_url
  const baseUrl = (providerConfig.base_url || providerConfig.baseURL || '').trim();
  if (!baseUrl) return false;

  const idLower = String(providerId).toLowerCase().trim();

  // Exclude managed accounts (e.g. managed:kimi-code)
  if (idLower.startsWith('managed:')) return false;

  // Exclude OAuth authenticated providers
  if (providerConfig.oauth !== undefined) return false;

  // Check built-in provider names against default official domains
  const isBuiltIn = BUILT_IN_PROVIDERS.has(idLower);
  if (isBuiltIn) {
    const urlLower = baseUrl.toLowerCase();
    const isOfficialEndpoint = DEFAULT_BUILTIN_DOMAINS.some((domain) => urlLower.includes(domain));
    if (isOfficialEndpoint) {
      return false;
    }
  }

  return true;
}

