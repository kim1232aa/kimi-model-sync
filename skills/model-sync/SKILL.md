---
name: model-sync
description: Synchronize custom gateway models with models.dev specifications and update ~/.kimi-code/config.toml (supports preview via --dry-run)
type: prompt
whenToUse: When the user asks to refresh, sync, or update models or provider configurations in Kimi Code
---

Please help the user synchronize their custom gateway models with official models.dev capabilities:

1. Determine whether the user wants a preview/dry-run before saving changes.
2. Execute the synchronization tool using `node ${KIMI_SKILL_DIR}/../../bin/kimi-model-sync.js "$@"` (or `npx kimi-model-sync "$@"`).
3. Verify that the updated model entries in `~/.kimi-code/config.toml` include appropriate capabilities (`thinking`, `image_in`, `tool_use`), correct context sizes, and supported effort levels, while built-in providers (`managed:kimi-code`, OAuth, official domains) and custom fields (`video_in`, `overrides`) remain untouched.
4. Summarize the changes to the user. If the file was written (not a dry run), tell them to run `/reload` (or restart Kimi Code) — the `/model` list only updates after a reload. If the script says "Refusing to write config.toml", nothing was written (the generated TOML failed validation); report the reason.
