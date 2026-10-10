---
description: Refresh and sync custom provider models from gateway endpoints against models.dev (supports --dry-run)
---

Please execute the model sync workflow for Kimi Code CLI:

1. Check if the user specified `--dry-run`, `-n`, or `--preview`.
2. Run the local script `node ${KIMI_PLUGIN_ROOT}/bin/kimi-model-sync.js "$@"` (or `npx kimi-model-sync "$@"`).
3. Read the resulting output summary table and diff report.
4. Present the synchronization status clearly, highlighting newly added, updated, and skipped models without touching built-in or managed providers.
