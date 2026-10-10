# kimi-model-sync

[English](README.md) | [中文](README.zh-CN.md)

Kimi Code CLI plugin and tool: automatically discover online models from custom and relay gateway providers, align capabilities against official [models.dev](https://models.dev) specifications, and keep `~/.kimi-code/config.toml` continuously updated.

---

## Features

- **Slash Command Integration**: Directly invoke `/kimi-model-sync:refresh` in Kimi Code chat to synchronize models interactively.
- **Agent Skill Support**: Ships with `/skill:model-sync`, allowing the AI agent to inspect and refresh configurations automatically upon request.
- **Dry-run Preview Mode**: Pass `--dry-run` (or `-n`) to inspect planned changes and detailed field diffs before writing to disk.
- **Automatic /v1 Probe & Fallback**: Smartly tests `/v1/models` and falls back to `/models`, preventing 404 errors on gateways configured without `/v1`.
- **Non-Destructive Patching (Zero Config Loss)**: Employs `smol-toml` AST parsing with verbatim section preservation, safeguarding existing comments, nested tables (e.g. `[providers."managed:kimi-code".oauth]`), and user custom fields (e.g. `video_in`).
- **Deep Effort & Modality Merging**: Automatically preserves user-defined reasoning efforts (e.g. `xhigh`, `minimal`) and modalities without clobbering fine-tuned settings.
- **Context Ceiling Protection**: Overrides gateway cutoff ceilings (such as 272k or 128k) using `Math.max(gateway, models.dev)`, restoring true model context limits (e.g., 1,050,000 tokens for `gpt-6-astra`).
- **Built-in & Managed Guard**: Automatically skips built-in official providers (`managed:kimi-code`, OAuth, official domains) unless explicitly targeted via `sync = true`.
- **Fuzzy Gateway Label Stripping**: Normalizes bracket tags (`[1m]`), route prefixes (`cx/`, `Agent-Plan/`), task qualifiers (`-review`, `-sol`, `-luna`), and tier suffixes (`-high`, `-low`, `-tiered`).
- **Non-Chat Model Filtering**: Automatically excludes embeddings, speech, text-to-speech, and image generation models from chat model tables.
- **Zero-Corruption Atomic Writes**: Implements clean TOML serialization with automatic `config.toml.bak` creation and PID-based atomic file replacement.

---

## Installation

### 1. As a Kimi Code Plugin (Recommended)

Inside Kimi Code CLI, run:

```bash
/plugins install github:kim1232aa/kimi-model-sync
```

Or install from a local clone:

```bash
/plugins install /path/to/kimi-model-sync
```

After installation, run `/reload` to activate the plugin.

### 2. As a Global CLI Utility

```bash
# Run directly via npx
npx kimi-model-sync

# Or install globally
npm install -g kimi-model-sync
```

---

## Usage

### In Kimi Code CLI

- **Slash command**:
  ```text
  /kimi-model-sync:refresh
  ```
- **Agent skill**:
  ```text
  /skill:model-sync
  ```

### In Shell / Terminal

Run the standalone CLI:

```bash
kimi-model-sync
```

Example output:

```text
🔄 [kimi-model-sync] Initializing Kimi Code model synchronization...
📂 Configuration target: /root/.kimi-code/config.toml

📊 Synchronization Report:
------------------------------------------------------------
 Provider            | Added | Updated | Total | Status
------------------------------------------------------------
 custom-gateway      |    12 |      45 |    57 | ✅ Success
------------------------------------------------------------

✨ All custom provider models synchronized successfully with models.dev!
💡 config.toml was updated. Run `/reload` in Kimi Code (or restart it) so the new models show up in /model.
```

---

## How It Works

1. Reads and parses `~/.kimi-code/config.toml` (or `$KIMI_CODE_HOME/config.toml`).
2. Discovers all custom providers declaring a `base_url` (retrieving tokens via `api_key` or `api_key_env`).
3. Fetches online models from the provider's `/v1/models` endpoint.
4. Queries [models.dev/api.json](https://models.dev) (with automatic local caching) to cross-reference official model metadata.
5. Populates `[models."<provider>/<model_id>"]` entries in `config.toml`, preserving any existing user `.overrides`.
6. Backs up the original file to `config.toml.bak` and writes atomically.

---

## License

MIT License

## Write safety (v1.1.0)

- **Validate before writing**: the new `config.toml` is fully parsed with a TOML parser and checked so that *only* the targeted models changed (every other top-level table and every untouched model must be field-for-field identical). If any check fails the tool **refuses to write** (`Refusing to write config.toml`) and leaves the original file alone — Kimi Code rejects an invalid TOML file as a whole, so a broken file must never reach disk. `--dry-run` runs the same checks.
- **Sub-tables survive**: `[models."<alias>".overrides]` and friends are merged into the model and written exactly once; non-target sections (`[providers."managed:kimi-code".oauth]`, `[thinking]`, `[secondary_model]`, `[[hooks]]`, …) and their comments stay verbatim.
- **`support_efforts` is always `array<string>`**, taken from the `type = "effort"` entry of models.dev `reasoning_options` (`none` becomes `off_effort = "none"`); entries corrupted by earlier releases are healed on the next sync.
- **Idempotent**: nothing to change → no write, no `.bak`.
- After a write, run `/reload` (or restart) in Kimi Code — the `/model` list only refreshes on reload.
