import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ModelsDevService {
  constructor(options = {}) {
    this.url = options.url || DEFAULT_MODELS_DEV_URL;
    this.cachePath = options.cachePath || null;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.memoryCatalog = null;
  }

  async getCatalog(signal) {
    if (this.memoryCatalog) {
      return this.memoryCatalog;
    }

    if (this.cachePath && fs.existsSync(this.cachePath)) {
      try {
        const stat = fs.statSync(this.cachePath);
        const age = Date.now() - stat.mtimeMs;
        if (age < this.ttlMs) {
          const raw = fs.readFileSync(this.cachePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            this.memoryCatalog = parsed;
            return parsed;
          }
        }
      } catch {
        // Cache read failed; proceed to remote fetch
      }
    }

    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), this.timeoutMs);
      const compositeSignal = signal
        ? AbortSignal.any([signal, abortCtrl.signal])
        : abortCtrl.signal;

      const res = await fetch(this.url, {
        headers: {
          'User-Agent': 'kimi-model-sync/1.0.0',
          Accept: 'application/json',
        },
        signal: compositeSignal,
      }).finally(() => clearTimeout(timer));

      if (res.ok) {
        const json = await res.json();
        if (json && typeof json === 'object') {
          this.memoryCatalog = json;
          if (this.cachePath) {
            try {
              const dir = path.dirname(this.cachePath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(this.cachePath, JSON.stringify(json), 'utf8');
            } catch {
              // Ignore cache write failures
            }
          }
          return json;
        }
      }
    } catch {
      // Remote fetch failed; try fallback to stale cache if present
      if (this.cachePath && fs.existsSync(this.cachePath)) {
        try {
          const raw = fs.readFileSync(this.cachePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            this.memoryCatalog = parsed;
            return parsed;
          }
        } catch {
          // Ignore
        }
      }
    }

    return null;
  }
}
