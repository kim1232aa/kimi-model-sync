---
description: Refresh and sync custom provider models from gateway endpoints against models.dev (supports --dry-run)
---

Please execute the model sync workflow for Kimi Code CLI:

1. Check if the user specified `--dry-run`, `-n`, or `--preview`.
2. Run the local script `node ${KIMI_PLUGIN_ROOT}/bin/kimi-model-sync.js "$@"` (or `npx kimi-model-sync "$@"`).
3. Read the resulting output summary table and diff report.
4. Present the synchronization status clearly, highlighting newly added, updated, and skipped models without touching built-in or managed providers.
5. If the config file was written (not `--dry-run`), tell the user to run `/reload` (or restart Kimi Code) — Kimi Code only re-reads `config.toml` on reload, so the model list in `/model` does not change before that. If the script reports "Refusing to write config.toml", nothing was written; show the reason.
