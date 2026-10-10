/**
 * Core normalization and specification logic for Kimi Code models.
 */

const NON_CHAT_ID_PATTERNS = [
  /(?:^|[-_/])(?:embed|embedding|rerank|reranker)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:tts|whisper|speech|audio|voice)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:dall-e|midjourney|flux|stable-diffusion|sdxl)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:moderation|guardrail|safety)(?:$|[-_/])/i,
];

export function isNonChatModel(id) {
  return NON_CHAT_ID_PATTERNS.some((pat) => pat.test(id));
}

export function parsePositiveNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

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

  // 6. Strip thinking & tier variants (e.g. "-high", "-low", "-medium", "-tiered", "-thinking", "-agent")
  const strippedVariants = strippedQualifiers
    .replace(/-(?:high|low|medium|tiered|extra|thinking|agent)$/i, '')
    .trim();
  candidates.add(strippedVariants);

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

export function lookupModelsDev(catalog, id) {
  if (!catalog || typeof catalog !== 'object') return null;

  const candidates = generateLookupCandidates(id);

  // 1. Direct model ID lookup across providers
  const matched = [];
  for (const [providerId, providerData] of Object.entries(catalog)) {
    const models = providerData?.models;
    if (!models || typeof models !== 'object') continue;

    for (const cand of candidates) {
      if (models[cand]) {
        matched.push({ providerId, modelId: cand, entry: models[cand] });
      }
    }
  }

  if (matched.length > 0) {
    return pickDevRepresentative(matched);
  }

  // 2. Secondary prefix fallback (e.g. "gpt-6" fallback to "gpt-5" or latest flagship)
  for (const [providerId, providerData] of Object.entries(catalog)) {
    const models = providerData?.models;
    if (!models || typeof models !== 'object') continue;

    for (const cand of candidates) {
      if (/^gpt-6/i.test(cand) && models['gpt-5.4']) {
        return models['gpt-5.4'];
      }
    }
  }

  return null;
}

export function inferVisionFromId(id) {
  const lower = id.toLowerCase();
  return (
    lower.includes('vision') ||
    lower.includes('vl') ||
    lower.includes('omni') ||
    lower.includes('gemini') ||
    lower.includes('gpt-4o') ||
    lower.includes('gpt-5') ||
    lower.includes('gpt-6') ||
    lower.includes('claude-3') ||
    lower.includes('claude-4') ||
    lower.includes('qwen-vl') ||
    lower.includes('glm-4v')
  );
}

export function inferReasoningFromId(id) {
  const lower = id.toLowerCase();
  return (
    lower.includes('reasoner') ||
    lower.includes('thinking') ||
    lower.includes('r1') ||
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('o4') ||
    lower.includes('kimi-k2') ||
    lower.includes('kimi-k3') ||
    lower.includes('glm-zero') ||
    lower.includes('qwq') ||
    lower.includes('deepseek-r1') ||
    lower.includes('gpt-5') ||
    lower.includes('gpt-6')
  );
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

  // 2. Preserve and merge reasoning efforts (preserve xhigh, minimal, etc.)
  if (generatedModel.support_efforts) {
    const existingEfforts = Array.isArray(existingModel.support_efforts) ? existingModel.support_efforts : [];
    const generatedEfforts = Array.isArray(generatedModel.support_efforts) ? generatedModel.support_efforts : [];
    const effortOrder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const mergedEffortsSet = new Set([...existingEfforts, ...generatedEfforts]);
    merged.support_efforts = effortOrder.filter((e) => mergedEffortsSet.has(e));
    if (merged.support_efforts.length === 0) {
      merged.support_efforts = Array.from(mergedEffortsSet);
    }
  }

  // 3. Keep user-defined default_effort and off_effort if already specified
  if (existingModel.default_effort) {
    merged.default_effort = existingModel.default_effort;
  }
  if (existingModel.off_effort) {
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

  // Vision resolution: override > raw=true > dev=true > raw=false > heuristic
  let vision = false;
  if (override?.vision !== undefined) {
    vision = Boolean(override.vision);
  } else if (caps.vision === true) {
    vision = true;
  } else if (devEntry?.modalities?.input?.includes('image')) {
    vision = true;
  } else if (caps.vision === false) {
    vision = false;
  } else {
    vision = inferVisionFromId(id);
  }

  // Reasoning resolution
  let reasoning = false;
  if (override?.reasoning !== undefined) {
    reasoning = Boolean(override.reasoning);
  } else if (
    caps.reasoning === true ||
    devEntry?.reasoning === true ||
    inferReasoningFromId(id) === true
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
    if (/grok|o1|o3|r1|deepseek-r1|k3/i.test(id)) {
      capabilities.push('always_thinking');
    }
  }

  const modelEntry = {
    provider: providerId,
    model: id,
    max_context_size: contextSize,
    max_output_size: outputSize,
    capabilities,
  };

  if (rawModel.name || devEntry?.name) {
    modelEntry.display_name = rawModel.name || devEntry?.name || id;
  }

  // Reasoning efforts support for Kimi Code:
  // Extract real options from models.dev reasoning_options or fallback gracefully
  if (reasoning) {
    const devEfforts = Array.isArray(devEntry?.reasoning_options)
      ? devEntry.reasoning_options
      : typeof devEntry?.reasoning_options === 'object' && devEntry?.reasoning_options !== null
        ? Object.keys(devEntry.reasoning_options)
        : null;

    if (devEfforts && devEfforts.length > 0) {
      modelEntry.support_efforts = devEfforts;
    } else {
      modelEntry.support_efforts = ['low', 'medium', 'high', 'max'];
    }
    modelEntry.default_effort = 'medium';
    modelEntry.off_effort = 'none';
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

