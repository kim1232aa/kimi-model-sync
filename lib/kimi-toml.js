import fs from 'node:fs';
import path from 'node:path';

/**
 * Lightweight and robust TOML parser tailored for Kimi Code config.toml structure.
 */
export function parseToml(content) {
  const root = {};
  let currentSection = root;
  let currentKeyPath = [];

  const lines = content.split(/\r?\n/);

  function getOrSetSection(pathArr) {
    let curr = root;
    for (const seg of pathArr) {
      if (!curr[seg] || typeof curr[seg] !== 'object' || Array.isArray(curr[seg])) {
        curr[seg] = {};
      }
      curr = curr[seg];
    }
    return curr;
  }

  function parseKey(rawKey) {
    rawKey = rawKey.trim();
    if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
      return rawKey.slice(1, -1);
    }
    if (rawKey.startsWith("'") && rawKey.endsWith("'")) {
      return rawKey.slice(1, -1);
    }
    return rawKey;
  }

  function splitSectionPath(header) {
    const parts = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < header.length; i++) {
      const ch = header[i];
      if ((ch === '"' || ch === "'") && (!inQuotes || quoteChar === ch)) {
        inQuotes = !inQuotes;
        quoteChar = inQuotes ? ch : '';
        current += ch;
      } else if (ch === '.' && !inQuotes) {
        if (current.trim()) parts.push(parseKey(current));
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(parseKey(current));
    return parts;
  }

  function parseValue(rawVal) {
    rawVal = rawVal.trim();
    if (rawVal === 'true') return true;
    if (rawVal === 'false') return false;
    if (/^-?\d+$/.test(rawVal)) return parseInt(rawVal, 10);
    if (/^-?\d+\.\d+$/.test(rawVal)) return parseFloat(rawVal);

    if ((rawVal.startsWith('"') && rawVal.endsWith('"')) || (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
      return rawVal.slice(1, -1);
    }

    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      const inner = rawVal.slice(1, -1).trim();
      if (!inner) return [];
      // Basic comma-separated string/value array parsing
      const items = [];
      let cur = '';
      let inQuotes = false;
      let quoteChar = '';
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if ((ch === '"' || ch === "'") && (!inQuotes || quoteChar === ch)) {
          inQuotes = !inQuotes;
          quoteChar = inQuotes ? ch : '';
          cur += ch;
        } else if (ch === ',' && !inQuotes) {
          if (cur.trim()) items.push(parseValue(cur.trim()));
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.trim()) items.push(parseValue(cur.trim()));
      return items;
    }

    return rawVal;
  }

  let inMultilineArray = false;
  let multilineArrayKey = '';
  let multilineArrayBuffer = '';

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();
    if (!line || line.startsWith('#')) continue;

    if (inMultilineArray) {
      multilineArrayBuffer += ' ' + line;
      if (line.includes(']')) {
        currentSection[multilineArrayKey] = parseValue(multilineArrayBuffer);
        inMultilineArray = false;
        multilineArrayKey = '';
        multilineArrayBuffer = '';
      }
      continue;
    }

    // Section header [table]
    if (line.startsWith('[') && line.endsWith(']') && !line.startsWith('[[')) {
      const headerContent = line.slice(1, -1).trim();
      currentKeyPath = splitSectionPath(headerContent);
      currentSection = getOrSetSection(currentKeyPath);
      continue;
    }

    // Array of tables [[table]] - preserved if present
    if (line.startsWith('[[') && line.endsWith(']]')) {
      const headerContent = line.slice(2, -2).trim();
      currentKeyPath = splitSectionPath(headerContent);
      let curr = root;
      for (let i = 0; i < currentKeyPath.length - 1; i++) {
        const seg = currentKeyPath[i];
        if (!curr[seg] || typeof curr[seg] !== 'object') curr[seg] = {};
        curr = curr[seg];
      }
      const lastSeg = currentKeyPath[currentKeyPath.length - 1];
      if (!Array.isArray(curr[lastSeg])) curr[lastSeg] = [];
      const newObj = {};
      curr[lastSeg].push(newObj);
      currentSection = newObj;
      continue;
    }

    // Key-value pair
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const rawKey = line.slice(0, eqIdx).trim();
      const rawVal = line.slice(eqIdx + 1).trim();
      const key = parseKey(rawKey);

      if (rawVal.startsWith('[') && !rawVal.endsWith(']')) {
        inMultilineArray = true;
        multilineArrayKey = key;
        multilineArrayBuffer = rawVal;
        continue;
      }

      currentSection[key] = parseValue(rawVal);
    }
  }

  return root;
}

/**
 * Format string or value for TOML.
 */
function formatTomlValue(val) {
  if (typeof val === 'string') {
    return JSON.stringify(val);
  }
  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }
  if (typeof val === 'number') {
    return String(val);
  }
  if (Array.isArray(val)) {
    return `[ ${val.map((item) => formatTomlValue(item)).join(', ')} ]`;
  }
  return JSON.stringify(String(val));
}

function escapeTomlKey(key) {
  if (/^[a-zA-Z0-9_-]+$/.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

/**
 * Serialize Kimi Code configuration object back to TOML.
 */
export function stringifyToml(config) {
  const chunks = [];

  // 1. Top-level scalars
  for (const [key, val] of Object.entries(config)) {
    if (val !== null && typeof val !== 'object') {
      chunks.push(`${escapeTomlKey(key)} = ${formatTomlValue(val)}`);
    } else if (Array.isArray(val) && val.every((x) => typeof x !== 'object')) {
      chunks.push(`${escapeTomlKey(key)} = ${formatTomlValue(val)}`);
    }
  }

  // 2. Providers section
  if (config.providers && typeof config.providers === 'object') {
    for (const [providerId, pData] of Object.entries(config.providers)) {
      chunks.push(`\n[providers.${escapeTomlKey(providerId)}]`);
      if (typeof pData === 'object' && pData !== null) {
        for (const [k, v] of Object.entries(pData)) {
          if (k !== 'env' && typeof v !== 'object') {
            chunks.push(`${escapeTomlKey(k)} = ${formatTomlValue(v)}`);
          }
        }
        if (pData.env && typeof pData.env === 'object') {
          chunks.push(`\n[providers.${escapeTomlKey(providerId)}.env]`);
          for (const [ek, ev] of Object.entries(pData.env)) {
            chunks.push(`${escapeTomlKey(ek)} = ${formatTomlValue(ev)}`);
          }
        }
      }
    }
  }

  // 3. Models section (grouped and cleanly indented)
  if (config.models && typeof config.models === 'object') {
    for (const [modelAlias, mData] of Object.entries(config.models)) {
      chunks.push(`\n[models.${escapeTomlKey(modelAlias)}]`);
      if (typeof mData === 'object' && mData !== null) {
        for (const [k, v] of Object.entries(mData)) {
          if (k !== 'overrides' && typeof v !== 'object') {
            chunks.push(`${escapeTomlKey(k)} = ${formatTomlValue(v)}`);
          } else if (Array.isArray(v)) {
            chunks.push(`${escapeTomlKey(k)} = ${formatTomlValue(v)}`);
          }
        }
        if (mData.overrides && typeof mData.overrides === 'object') {
          chunks.push(`\n[models.${escapeTomlKey(modelAlias)}.overrides]`);
          for (const [ok, ov] of Object.entries(mData.overrides)) {
            chunks.push(`${escapeTomlKey(ok)} = ${formatTomlValue(ov)}`);
          }
        }
      }
    }
  }

  // 4. Other tables (e.g. thinking, loop_control, services, background, secondary_model)
  const handled = new Set(['providers', 'models']);
  for (const [secKey, secVal] of Object.entries(config)) {
    if (handled.has(secKey)) continue;
    if (Array.isArray(secVal)) {
      // Array of tables [[table]]
      for (const item of secVal) {
        if (typeof item === 'object' && item !== null) {
          chunks.push(`\n[[${secKey}]]`);
          for (const [k, v] of Object.entries(item)) {
            chunks.push(`${escapeTomlKey(k)} = ${formatTomlValue(v)}`);
          }
        }
      }
    } else if (typeof secVal === 'object' && secVal !== null) {
      chunks.push(`\n[${escapeTomlKey(secKey)}]`);
      for (const [k, v] of Object.entries(secVal)) {
        if (typeof v !== 'object') {
          chunks.push(`${escapeTomlKey(k)} = ${formatTomlValue(v)}`);
        } else if (Array.isArray(v)) {
          chunks.push(`${escapeTomlKey(k)} = ${formatTomlValue(v)}`);
        } else if (typeof v === 'object' && v !== null) {
          chunks.push(`\n[${escapeTomlKey(secKey)}.${escapeTomlKey(k)}]`);
          for (const [subK, subV] of Object.entries(v)) {
            chunks.push(`${escapeTomlKey(subK)} = ${formatTomlValue(subV)}`);
          }
        }
      }
    }
  }

  return chunks.join('\n') + '\n';
}

/**
 * Safely update config.toml with automatic backup and atomic write.
 */
export function writeConfigAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 1. Create backup if file exists
  if (fs.existsSync(filePath)) {
    try {
      const backupPath = `${filePath}.bak`;
      fs.copyFileSync(filePath, backupPath);
    } catch {
      // Ignore backup failures
    }
  }

  // 2. Atomic write via temporary file
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}
