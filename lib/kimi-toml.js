import fs from 'node:fs';
import path from 'node:path';
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
 * Extract model key from a table header line like:
 * [models."provider/model"]
 * [models.'provider/model']
 * [models.provider/model]
 */
export function extractModelKeyFromHeader(headerLine) {
  const trimmed = headerLine.trim();
  const match = trimmed.match(/^\[\s*models\s*\.\s*(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_\-.:\/]+))\s*\]$/);
  if (!match) return null;
  return match[1] || match[2] || match[3] || null;
}

/**
 * Non-destructively patch models in an existing TOML text.
 * Preserves all comments, providers (including nested oauth tables), and non-model sections.
 * Upserts updated and added models safely.
 */
export function patchConfigModels(originalText, modelsToUpsert = {}) {
  if (!originalText || !originalText.trim()) {
    // If original file is empty, simply stringify all models
    if (Object.keys(modelsToUpsert).length === 0) return '';
    return toml.stringify({ models: modelsToUpsert });
  }

  const lines = originalText.split(/\r?\n/);
  const sections = [];
  let currentHeader = null;
  let currentLines = [];

  for (const line of lines) {
    const isHeader = /^\s*\[[^\]]+\]\s*$/.test(line);
    if (isHeader) {
      if (currentHeader !== null || currentLines.length > 0) {
        sections.push({ header: currentHeader, lines: currentLines });
      }
      currentHeader = line;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentHeader !== null || currentLines.length > 0) {
    sections.push({ header: currentHeader, lines: currentLines });
  }

  const remainingKeys = new Set(Object.keys(modelsToUpsert));
  const outputParts = [];

  for (const section of sections) {
    if (!section.header) {
      // Header-less prelude (comments, global configs) -> keep 100% verbatim
      outputParts.push(section.lines.join('\n'));
      continue;
    }

    const modelKey = extractModelKeyFromHeader(section.header);
    if (modelKey && remainingKeys.has(modelKey)) {
      // Replace existing model block with merged/updated content
      const updatedModel = modelsToUpsert[modelKey];
      outputParts.push(formatModelBlock(modelKey, updatedModel).trimEnd());
      remainingKeys.delete(modelKey);
    } else {
      // Preserve other sections (providers, oauth, other models, comments) verbatim
      const block = [section.header, ...section.lines].join('\n');
      outputParts.push(block);
    }
  }

  // Append newly added models that did not exist in original text
  if (remainingKeys.size > 0) {
    const sortedNewKeys = Array.from(remainingKeys).sort();
    for (const newKey of sortedNewKeys) {
      const modelData = modelsToUpsert[newKey];
      outputParts.push(formatModelBlock(newKey, modelData).trimEnd());
    }
  }

  let finalOutput = outputParts.filter((p) => p.length > 0).join('\n\n').trim();
  return `${finalOutput}\n`;
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
