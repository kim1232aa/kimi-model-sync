import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ModelsDevService } from './models-dev.js';
import {
  isNonChatModel,
  lookupModelsDev,
  buildKimiModel,
} from './core.js';
import {
  parseToml,
  stringifyToml,
  writeConfigAtomic,
} from './kimi-toml.js';

export function resolveKimiConfigPath() {
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'config.toml');
}

async function fetchGatewayModels(baseUrl, apiKey, timeoutMs = 20000) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers = {
    'User-Agent': 'kimi-model-sync/1.0.0',
    Accept: 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers,
      signal: abortCtrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      throw new Error(`Upstream returned HTTP ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    const list = Array.isArray(json)
      ? json
      : (json?.data || json?.models || json?.result || []);

    if (!Array.isArray(list)) {
      throw new Error(`Invalid models payload: expected array, got ${typeof list}`);
    }

    return list;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function syncKimiModels(options = {}) {
  const configPath = options.configPath || resolveKimiConfigPath();
  const logger = options.logger || console;

  if (!fs.existsSync(configPath)) {
    throw new Error(`Kimi Code configuration file not found at: ${configPath}`);
  }

  const rawToml = fs.readFileSync(configPath, 'utf8');
  const config = parseToml(rawToml);

  const providers = config.providers || {};
  const existingModels = config.models || {};
  if (!config.models) {
    config.models = existingModels;
  }

  // Find eligible custom providers that declare a base_url
  const eligibleProviders = Object.entries(providers).filter(([_, pData]) => {
    if (!pData || typeof pData !== 'object') return false;
    return Boolean(pData.base_url || pData.baseURL);
  });

  if (eligibleProviders.length === 0) {
    return {
      success: true,
      configPath,
      message: 'No custom providers with base_url found in config.toml.',
      results: [],
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
      added: 0,
      updated: 0,
      total: 0,
      error: null,
    };

    try {
      const remoteList = await fetchGatewayModels(baseUrl, apiKey, options.timeoutMs);
      const chatModels = remoteList.filter((m) => {
        const id = typeof m === 'string' ? m : m.id;
        return id && !isNonChatModel(id);
      });

      for (const raw of chatModels) {
        const id = typeof raw === 'string' ? raw : raw.id;
        const alias = `${providerId}/${id}`;
        const devEntry = lookupModelsDev(catalog, id);
        const normalized = buildKimiModel(providerId, id, typeof raw === 'object' ? raw : {}, devEntry);

        if (config.models[alias]) {
          // Update existing model entry while preserving any user overrides
          const current = config.models[alias];
          const overrides = current.overrides;
          Object.assign(current, normalized);
          if (overrides) current.overrides = overrides;
          providerResult.updated++;
        } else {
          config.models[alias] = normalized;
          providerResult.added++;
        }
      }

      providerResult.total = chatModels.length;
    } catch (err) {
      providerResult.error = err.message;
      logger.error?.(`[kimi-model-sync] Failed to sync provider "${providerId}": ${err.message}`);
    }

    syncResults.push(providerResult);
  }

  // Serialize and atomically write back to config.toml
  const newToml = stringifyToml(config);
  writeConfigAtomic(configPath, newToml);

  return {
    success: true,
    configPath,
    results: syncResults,
  };
}
