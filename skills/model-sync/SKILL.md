---
name: model-sync
description: Synchronize custom gateway models with models.dev specifications and update ~/.kimi-code/config.toml
type: prompt
whenToUse: When the user asks to refresh, sync, or update models or provider configurations in Kimi Code
---

Please help the user synchronize their custom gateway models with official models.dev capabilities:

1. Execute the synchronization tool using `node ${KIMI_SKILL_DIR}/../../bin/kimi-model-sync.js` (or `npx kimi-model-sync`).
2. Verify that the updated model entries in `~/.kimi-code/config.toml` include appropriate capabilities (`thinking`, `image_in`, `tool_use`), correct context sizes, and supported effort levels.
3. Summarize the changes to the user and notify them to restart or run `/reload` to apply the updated models.
