import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as toml from 'smol-toml';

/**
 * Standard TOML parsing via smol-toml.
 * Fully supports nested tables, quotes, arrays, and standard TOML 1.0 syntax.
 */
export function parseToml(text) {
  if (!text || !text.trim()) return {};
  return toml.parse(text);
}

/**
 * Serialize a JavaScript object into TOML string.
 */
export function stringifyToml(data) {
  return toml.stringify(data);
}

/**
 * Format a single model entry into standard TOML block.
 */
export function formatModelBlock(modelKey, modelData) {
  const content = toml.stringify({
    models: {
      [modelKey]: modelData,
    },
  }).trim();
  return `${content}\n`;
}

/**
 * Parse a TOML table header line such as
 *   [models."provider/model[1m]"]
 *   [models."provider/model".overrides]   # trailing comment
 *   [[models."provider/model".something]]
 * Returns { isArray, parts } (dotted-key segments, unquoted/unescaped) or null
 * when the line is not a table header. Quoted segments may contain `]`, `.`, `#`.
 */
export function parseTableHeader(line) {
  const open = /^\s*(\[\[?)/.exec(line);
  if (!open) return null;
  const isArray = open[1] === '[[';
  let i = open[0].length;
  const parts = [];
  const skipWs = () => {
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  };

  for (;;) {
    skipWs();
    const ch = line[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\') j++;
        j++;
      }
      if (j >= line.length) return null;
      try {
        parts.push(JSON.parse(line.slice(i, j + 1)));
      } catch {
        return null;
      }
      i = j + 1;
    } else if (ch === "'") {
      const j = line.indexOf("'", i + 1);
      if (j === -1) return null;
      parts.push(line.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    skipWs();
    if (line[i] === '.') {
      i++;
      continue;
    }
    break;
  }

  const close = isArray ? ']]' : ']';
  if (line.slice(i, i + close.length) !== close) return null;
  i += close.length;
  const rest = line.slice(i).trim();
  if (rest !== '' && !rest.startsWith('#')) return null;
  return { isArray, parts };
}

/**
 * Extract the model alias from a `[models."<alias>"]` header.
 * Returns null for non-model headers AND for sub-table headers such as
 * `[models."<alias>".overrides]` (use parseModelHeader to tell them apart).
 */
export function extractModelKeyFromHeader(headerLine) {
  const parsed = parseModelHeader(headerLine);
  if (!parsed || parsed.isSubTable) return null;
  return parsed.modelKey;
}

/**
 * Classify a header line that belongs to the `models` table.
 * -> { modelKey, isSubTable, subPath } or null.
 */
export function parseModelHeader(headerLine) {
  const header = parseTableHeader(headerLine);
  if (!header || header.parts[0] !== 'models' || header.parts.length < 2) return null;
  return {
    modelKey: header.parts[1],
    isSubTable: header.parts.length > 2 || header.isArray,
    subPath: header.parts.slice(2),
  };
}

function isCommentLine(line) {
  return /^\s*#/.test(line);
}

/**
 * Split text into sections. Comment lines that sit directly above a header
 * (separated from the previous section's body) travel with that header, so
 * replacing/removing a section never swallows the next section's comments.
 */
function splitSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = { leading: [], header: null, lines: [] };

  const flush = (nextLeading) => {
    sections.push(current);
    current = { leading: nextLeading, header: null, lines: [] };
  };

  for (const line of lines) {
    if (parseTableHeader(line)) {
      // Move the trailing comment run (and only that) to the new section.
      const body = current.lines;
      let k = body.length;
      while (k > 0 && (isCommentLine(body[k - 1]) || body[k - 1].trim() === '')) k--;
      let firstComment = -1;
      for (let m = k; m < body.length; m++) {
        if (isCommentLine(body[m])) {
          firstComment = m;
          break;
        }
      }
      let leading = [];
      if (firstComment !== -1) {
        leading = body.slice(firstComment);
        current.lines = body.slice(0, firstComment);
      }
      flush(leading);
      current.header = line;
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function trimTrailingBlank(lines) {
  const out = lines.slice();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/**
 * Non-destructively patch models in an existing TOML text.
 *
 * - Every section that does not belong to an upserted model is kept byte-for-byte
 *   (comments, providers incl. `.oauth`, [thinking], [secondary_model], other models).
 * - For an upserted model, the main table AND all of its sub-tables
 *   (`.overrides`, array tables, ...) are replaced by ONE regenerated block. The
 *   sub-table content is already part of the merged entry (see mergeModelEntry), so
 *   keeping the old sub-table text as well would define the table twice (invalid TOML).
 * - With nothing to upsert the original text is returned untouched.
 */
export function patchConfigModels(originalText, modelsToUpsert = {}) {
  const upsertKeys = Object.keys(modelsToUpsert);

  if (!originalText || !originalText.trim()) {
    if (upsertKeys.length === 0) return '';
    return toml.stringify({ models: modelsToUpsert });
  }
  if (upsertKeys.length === 0) return originalText;

  const sections = splitSections(originalText);
  const handled = new Set();
  const out = [];

  for (const section of sections) {
    out.push(...section.leading);
    if (section.header === null) {
      out.push(...section.lines);
      continue;
    }

    const parsed = parseModelHeader(section.header);
    if (parsed && Object.prototype.hasOwnProperty.call(modelsToUpsert, parsed.modelKey)) {
      if (!handled.has(parsed.modelKey)) {
        handled.add(parsed.modelKey);
        out.push(...formatModelBlock(parsed.modelKey, modelsToUpsert[parsed.modelKey]).trimEnd().split('\n'));
        out.push('');
      }
      continue; // drop old main table / sub-tables of this model
    }

    out.push(section.header, ...section.lines);
  }

  const newKeys = upsertKeys.filter((k) => !handled.has(k)).sort();
  if (newKeys.length > 0) {
    const body = trimTrailingBlank(out);
    out.length = 0;
    out.push(...body);
    for (const key of newKeys) {
      out.push('', ...formatModelBlock(key, modelsToUpsert[key]).trimEnd().split('\n'));
    }
  }

  return `${trimTrailingBlank(out).join('\n')}\n`;
}

function toPlain(value) {
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const o = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) o[k] = toPlain(v);
    }
    return o;
  }
  return value;
}

/**
 * Safety gate: prove the patched text is valid TOML and that it only differs from
 * the original in the models we meant to touch. Throws (and the caller must NOT
 * write) otherwise. Kimi Code rejects an invalid config.toml as a whole.
 */
export function validatePatchedConfig(originalConfig, patchedText, expectedModels = {}) {
  let parsed;
  try {
    parsed = toml.parse(patchedText);
  } catch (err) {
    throw new Error(`Refusing to write config.toml: generated TOML is invalid (${err.message}). No changes were made.`);
  }

  const before = toPlain(originalConfig || {});
  const after = toPlain(parsed);

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'models') continue;
    if (!isDeepStrictEqual(before[key], after[key])) {
      throw new Error(`Refusing to write config.toml: top-level "${key}" would change. No changes were made.`);
    }
  }

  const beforeModels = before.models || {};
  const afterModels = after.models || {};
  const expected = toPlain(expectedModels);

  for (const alias of Object.keys(beforeModels)) {
    if (!(alias in afterModels)) {
      throw new Error(`Refusing to write config.toml: model "${alias}" would be lost. No changes were made.`);
    }
    if (!(alias in expected) && !isDeepStrictEqual(beforeModels[alias], afterModels[alias])) {
      throw new Error(`Refusing to write config.toml: untouched model "${alias}" would change. No changes were made.`);
    }
  }
  for (const [alias, want] of Object.entries(expected)) {
    if (!isDeepStrictEqual(afterModels[alias], want)) {
      throw new Error(`Refusing to write config.toml: model "${alias}" did not round-trip. No changes were made.`);
    }
  }
  return parsed;
}

/**
 * Write configuration file atomically with automatic .bak backup.
 */
export function writeConfigAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Create .bak backup if file exists
  if (fs.existsSync(filePath)) {
    try {
      const backupPath = `${filePath}.bak`;
      fs.copyFileSync(filePath, backupPath);
    } catch {
      // Backup best-effort
    }
  }

  const tempPath = path.join(dir, `.config.toml.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}
