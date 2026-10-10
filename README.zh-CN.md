# kimi-model-sync

[English](README.md) | [中文说明](README.zh-CN.md)

Kimi Code CLI 官方插件与自动化工具：自动从中转和自定义网关发现线上模型，对齐 [models.dev](https://models.dev) 官方权威能力规格，安全写回并更新 `~/.kimi-code/config.toml`。

---

## 核心特性

- **官方斜杠命令集成**：在 Kimi Code 对话框中直接输入 `/kimi-model-sync:refresh`，一键交互式触发模型同步。
- **Agent 技能支持**：配套内置 `/skill:model-sync` 技能，Agent 在需要时可自主检测并执行模型列表同步。
- **防止上下文截断 (272k 保护)**：针对中转网关计费阈值截断（如 272k / 128k），使用 `Math.max(网关值, 官方标准值)` 恢复真实百万上下文（如 `gpt-6-astra` 恢复为 105 万）。
- **标签与路由智能剥离**：自动识别并剔除中括号计费标签（`[1m]`）、路由前缀（`cx/`, `Agent-Plan/`）、任务修饰符（`-review`, `-sol`, `-luna`）及等级后缀（`-high`, `-low`, `-tiered`）。
- **Kimi Code 专属能力对齐**：精确推断并生成 Kimi 规范能力数组（`image_in` 看图、`thinking` 思考、`always_thinking` 强制思考、`tool_use` 工具调用）与思考阶梯（`support_efforts = ["low", "medium", "high", "max"]`）。
- **非聊天模型过滤**：自动过滤 embedding、tts、whisper 语音及绘图模型，保持模型列表整洁。
- **零外部依赖与原子安全写入**：纯原生 TOML 解析器与生成器，自动生成 `config.toml.bak` 备份文件并通过 PID 临时文件原子替换，杜绝文件损坏。

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
💡 Restart Kimi Code CLI or run `/reload` to apply updated models.
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
