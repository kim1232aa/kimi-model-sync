# kimi-model-sync

[English](README.md) | [中文说明](README.zh-CN.md)

Kimi Code CLI 官方插件与自动化工具：自动从中转和自定义网关发现线上模型，对齐 [models.dev](https://models.dev) 官方权威能力规格，安全写回并更新 `~/.kimi-code/config.toml`。

---

## 核心特性

- **官方斜杠命令集成**：在 Kimi Code 对话框中直接输入 `/kimi-model-sync:refresh`，一键交互式触发模型同步。
- **Agent 技能支持**：配套内置 `/skill:model-sync` 技能，Agent 在需要时可自主检测并执行模型列表同步。
- **--dry-run 预览模式**：支持传入 `--dry-run`（或 `-n`、`--preview`），在修改磁盘前清晰预览新增、更新字段与能力 Diff，零改动风险。
- **智能 /v1 探测与平滑回退**：自动探测 `/v1/models` 与 `/models`，彻底解决网关 `base_url` 未写 `/v1` 导致 404 Not Found 的问题。
- **非破坏性切片合并（零配置丢失）**：采用 `smol-toml` 结合原文切片保护机制，100% 完整保留原有注释、嵌套表（如 `[providers."managed:kimi-code".oauth]`）与用户自定义扩展字段（如 `video_in`、`custom_note`）。
- **思考档位与多模态深度保留**：深度合并思考档位（保留 `xhigh`、`minimal` 等特化档位），杜绝直接写死四档覆盖；保留用户已有自定义能力。
- **防止上下文截断 (272k 保护)**：针对中转网关计费阈值截断（如 272k / 128k），使用 `Math.max(网关值, 官方标准值)` 恢复真实百万上下文（如 `gpt-6-astra` 恢复为 105 万）。
- **内置与托管提供商严密规避**：严格跳过官方托管账号 `managed:kimi-code`、OAuth 授权账号以及官方域名直连服务，避免误伤与配置污染（支持 `sync = true` 显式开启）。
- **标签与路由智能剥离**：自动识别并剔除中括号计费标签（`[1m]`）、路由前缀（`cx/`, `Agent-Plan/`）、任务修饰符（`-review`, `-sol`, `-luna`）及等级后缀（`-high`, `-low`, `-tiered`）。
- **非聊天模型过滤**：自动过滤 embedding、tts、whisper 语音及绘图模型，保持模型列表整洁。
- **原子安全写入与自动备份**：写入前自动在同级生成 `config.toml.bak`，并通过 PID 临时文件原子替换，杜绝文件损坏。

---

## 安装方法

### 1. 作为 Kimi Code 插件安装（推荐）

在 Kimi Code CLI 终端交互界面中直接运行：

```bash
/plugins install github:kim1232aa/kimi-model-sync
```

或者从本地路径安装：

```bash
/plugins install /path/to/kimi-model-sync
```

安装完成后，输入 `/reload` 即可加载生效。

### 2. 作为全局命令行工具安装

```bash
# 直接使用 npx 运行
npx kimi-model-sync

# 或全局安装
npm install -g kimi-model-sync
```

---

## 使用指南

### 在 Kimi Code CLI 中

- **触发斜杠命令**：
  ```text
  /kimi-model-sync:refresh
  ```
- **调用 Agent 技能**：
  ```text
  /skill:model-sync
  ```

### 在系统终端中使用

直接执行 CLI 命令：

```bash
kimi-model-sync
```

输出示例：

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

## 工作机制

1. 读取并解析 `~/.kimi-code/config.toml`（或 `$KIMI_CODE_HOME/config.toml`）。
2. 扫描所有配置了 `base_url` 的自定义提供商（支持 `api_key` 或环境变量 `api_key_env`）。
3. 请求提供商的 `/v1/models` 端点拉取在线模型。
4. 查询权威库 [models.dev/api.json](https://models.dev)（本地带 24 小时缓存保护）进行元数据对齐。
5. 生成并在 `config.toml` 中添加/更新 `[models."<provider>/<model_id>"]` 节点，同时完整保留用户已存在的自定义 `.overrides`。
6. 自动创建 `config.toml.bak` 备份文件，并原子化安全写入。

---

## 开源协议

MIT License

## 写入安全（v1.1.0）

- **写入前先验证**：生成的新 `config.toml` 会先用 TOML 解析器完整解析，并校验“只有目标模型发生变化”（其他顶层配置、其他模型逐字段不变）。任一项不通过就**拒绝写入**并报 `Refusing to write config.toml`，原文件保持不动（Kimi Code 对非法 TOML 会整份拒绝，所以绝不写出坏文件）。`--dry-run` 同样会走这套校验。
- **子表保留**：`[models."<alias>".overrides]` 等子表随模型一起合并后只写一次；`[providers."managed:kimi-code".oauth]`、`[thinking]`、`[secondary_model]`、`[[hooks]]` 等非目标段落保持原文（含注释）。
- **`support_efforts` 一律是字符串数组**，只取 models.dev `reasoning_options` 里 `type = "effort"` 的档位（`none` 会转成 `off_effort = "none"`）；旧版本写坏的条目会在下次同步时自动修复。
- **幂等**：没有变化时不写文件、不产生 `.bak`。
- 写入后必须在 Kimi Code 里执行 `/reload`（或重启）才会刷新 `/model` 列表。
