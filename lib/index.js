import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ModelsDevService } from './models-dev.js';
import {
  isNonChatModel,
  lookupModelsDev,
  buildKimiModel,
  isCustomProvider,
  getCandidateModelUrls,
} from './core.js';
import {
  parseToml,
  patchConfigModels,
  validatePatchedConfig,
  writeConfigAtomic,
} from './kimi-toml.js';

export function resolveKimiConfigPath() {
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'config.toml');
}

/**
 * Robustly fetch models from candidate URLs.
 * Handles missing /v1 by automatically testing /v1/models and falling back to /models.
 */
async function fetchGatewayModels(baseUrl, apiKey, timeoutMs = 20000, logger = console) {
  const candidates = getCandidateModelUrls(baseUrl);
  const headers = {
    'User-Agent': 'kimi-model-sync/1.1.0',
    Accept: 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let lastError = null;

  for (const url of candidates) {
    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        headers,
        signal: abortCtrl.signal,
      }).finally(() => clearTimeout(timer));

      if (res.status === 404 || res.status === 405) {
        lastError = new Error(`Endpoint ${url} returned HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) {
        throw new Error(`Upstream returned HTTP ${res.status} ${res.statusText}`);
      }

      const json = await res.json();
      const list = Array.isArray(json)
        ? json
        : (json?.data || json?.models || json?.result || []);

      if (!Array.isArray(list)) {
        throw new Error(`Invalid models payload from ${url}: expected array, got ${typeof list}`);
      }

      return { list, matchedUrl: url };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
    }
  }

  throw lastError || new Error(`Failed to fetch models from candidate endpoints: ${candidates.join(', ')}`);
}

/** Order- and prototype-insensitive structural equality (smol-toml yields null-prototype objects). */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (value[k] !== undefined) out[k] = canonical(value[k]);
    }
    return out;
  }
  return value;
}

function sameModel(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function computeModelDiff(existing, normalized) {
  if (!existing) {
    return {
      type: 'add',
      details: `context: ${normalized.max_context_size}, output: ${normalized.max_output_size}, caps: [${(normalized.capabilities || []).join(', ')}]`,
    };
  }

  const changes = [];
  if (existing.max_context_size !== normalized.max_context_size) {
    changes.push(`context: ${existing.max_context_size} -> ${normalized.max_context_size}`);
  }
  if (existing.max_output_size !== normalized.max_output_size) {
    changes.push(`output: ${existing.max_output_size} -> ${normalized.max_output_size}`);
  }

  const oldCaps = new Set(existing.capabilities || []);
  const newCaps = new Set(normalized.capabilities || []);
  const addedCaps = Array.from(newCaps).filter((c) => !oldCaps.has(c));
  if (addedCaps.length > 0) {
    changes.push(`added caps: +[${addedCaps.join(', ')}]`);
  }

  const oldEfforts = JSON.stringify(Array.isArray(existing.support_efforts) ? existing.support_efforts : []);
  const newEfforts = JSON.stringify(Array.isArray(normalized.support_efforts) ? normalized.support_efforts : []);
  if (oldEfforts !== newEfforts) {
    changes.push(`efforts: ${oldEfforts} -> ${newEfforts}`);
  }

  if (changes.length > 0) {
    return {
      type: 'update',
      details: changes.join('; '),
    };
  }

  if (!sameModel(existing, normalized)) {
    return { type: 'update', details: 'metadata normalized' };
  }

  return { type: 'unchanged' };
}

export async function syncKimiModels(options = {}) {
  const configPath = options.configPath || resolveKimiConfigPath();
  const logger = options.logger || console;
  const dryRun = Boolean(options.dryRun);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Kimi Code configuration file not found at: ${configPath}`);
  }

  const rawToml = fs.readFileSync(configPath, 'utf8');
  const config = parseToml(rawToml);

  const providers = config.providers || {};
  const existingModels = config.models || {};

  // Find eligible custom providers using strict builtin/managed guard
  const eligibleProviders = Object.entries(providers).filter(([providerId, pData]) => {
    return isCustomProvider(providerId, pData);
  });

  if (eligibleProviders.length === 0) {
    return {
      success: true,
      dryRun,
      configPath,
      message: 'No eligible custom providers found in config.toml (built-in providers and managed accounts safely skipped).',
      results: [],
      diffSummary: [],
    };
  }

  // Load models.dev catalog
  const cachePath = options.modelsDevCachePath || path.join(path.dirname(configPath), 'models-dev-cache.json');
  const modelsDev = new ModelsDevService({
    url: options.modelsDevUrl,
    cachePath,
    timeoutMs: 15000,
  });

  const catalog = await modelsDev.getCatalog();
  if (!catalog) {
    logger.warn?.('[kimi-model-sync] Could not retrieve models.dev catalog; using heuristic fallback.');
  }

  const syncResults = [];
  const modelsToUpsert = {};
  const diffSummary = [];

  for (const [providerId, pData] of eligibleProviders) {
    const baseUrl = pData.base_url || pData.baseURL;
    let apiKey = pData.api_key;
    if (!apiKey && pData.api_key_env) {
      apiKey = process.env[pData.api_key_env];
    } else if (!apiKey && pData.env?.KIMI_API_KEY) {
      apiKey = pData.env.KIMI_API_KEY;
    }

    const providerResult = {
      providerId,
      baseUrl,
      matchedUrl: null,
      added: 0,
      updated: 0,
      unchanged: 0,
      total: 0,
      error: null,
    };

    try {
      const { list: remoteList, matchedUrl } = await fetchGatewayModels(
        baseUrl,
        apiKey,
        options.timeoutMs,
        logger,
      );
      providerResult.matchedUrl = matchedUrl;

      const chatModels = remoteList.filter((m) => {
        const id = typeof m === 'string' ? m : m.id;
        return id && !isNonChatModel(id);
      });

      for (const raw of chatModels) {
        const id = typeof raw === 'string' ? raw : raw.id;
        const alias = `${providerId}/${id}`;
        const devEntry = lookupModelsDev(catalog, id);
        const existing = existingModels[alias];

        const normalized = buildKimiModel(
          providerId,
          id,
          typeof raw === 'object' ? raw : {},
          devEntry,
          undefined,
          existing,
        );

        const diff = computeModelDiff(existing, normalized);
        if (diff.type === 'add') {
          providerResult.added++;
          diffSummary.push({ model: alias, action: 'add', details: diff.details });
        } else if (diff.type === 'update') {
          providerResult.updated++;
          diffSummary.push({ model: alias, action: 'update', details: diff.details });
        } else {
          providerResult.unchanged++;
        }

        // Only touch models that actually change; untouched entries stay byte-for-byte.
        if (diff.type !== 'unchanged') {
          modelsToUpsert[alias] = normalized;
        }
      }

      providerResult.total = chatModels.length;
    } catch (err) {
      providerResult.error = err.message;
      logger.error?.(`[kimi-model-sync] Failed to sync provider "${providerId}": ${err.message}`);
    }

    syncResults.push(providerResult);
  }

  // Build the new text and prove it is valid BEFORE anything is written
  // (also in --dry-run, so a preview tells the truth about whether the write would succeed).
  // Kimi Code rejects an invalid config.toml as a whole, so we never write one.
  let wrote = false;
  if (Object.keys(modelsToUpsert).length > 0) {
    const patchedToml = patchConfigModels(rawToml, modelsToUpsert);
    validatePatchedConfig(config, patchedToml, modelsToUpsert);
    if (!dryRun) {
      writeConfigAtomic(configPath, patchedToml);
      wrote = true;
    }
  }

  return {
    success: true,
    dryRun,
    configPath,
    wrote,
    results: syncResults,
    diffSummary,
  };
}
