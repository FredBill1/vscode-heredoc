# Heredoc Embedded Languages

在 sh/Bash 的 `shellscript` 文件中，根据 heredoc 的 delimiter 为正文添加嵌入语言高亮，并尝试复用已安装语言扩展的补全、悬停、定义和诊断。普通 shell 代码继续由现有的 shell 语法和扩展处理；本扩展不会自动安装或启用其他扩展。

## 快速开始

运行 `npm run package` 后，可用 `code --install-extension vscode-heredoc.vsix` 安装生成的 VSIX。打开 Bash 脚本，输入：

```sh
python3 <<'PY'
print('hello from Python')
PY
```

`PY` 会映射为 VS Code 的 `python` 语言。可在 [`examples/example.sh`](examples/example.sh) 查看 YAML、TypeScript、多个 heredoc 和嵌套 shell 示例。可选的语言扩展包括 Python 的 `ms-python.python`、YAML 的 `redhat.vscode-yaml` 和 shell 的 `mads-hartmann.bash-ide-vscode`；TypeScript 使用 VS Code 自带的语言支持。即使对应扩展缺席或禁用，也会尽可能保留语法高亮。

## Delimiter 规则

预设规则不区分大小写，覆盖以下 14 类语言：

| 语言       | Delimiter             | `languageId`  |
| ---------- | --------------------- | ------------- |
| Python     | `PY`, `PYTHON`        | `python`      |
| YAML       | `YML`, `YAML`         | `yaml`        |
| Shell      | `SH`, `SHELL`, `BASH` | `shellscript` |
| TypeScript | `TS`, `TYPESCRIPT`    | `typescript`  |
| JavaScript | `JS`, `JAVASCRIPT`    | `javascript`  |
| JSON       | `JSON`                | `json`        |
| SQL        | `SQL`                 | `sql`         |
| HTML       | `HTML`, `HTM`         | `html`        |
| CSS        | `CSS`                 | `css`         |
| XML        | `XML`                 | `xml`         |
| Markdown   | `MD`, `MARKDOWN`      | `markdown`    |
| Ruby       | `RB`, `RUBY`          | `ruby`        |
| Go         | `GO`, `GOLANG`        | `go`          |
| Rust       | `RS`, `RUST`          | `rust`        |

可在 `settings.json` 中添加自定义规则：

```jsonc
{
  "heredoc.rules": [
    {
      "pattern": "CONFIG|SETTINGS",
      "languageId": "yaml",
      "flags": "i",
      "documentMode": "auto"
    },
    {
      "pattern": "PY",
      "languageId": "javascript"
    }
  ],
  "heredoc.enablePresets": true
}
```

自定义规则按数组顺序匹配，优先于预设；第二条规则会覆盖预设的 `PY`。正则表达式必须匹配**整个** delimiter，匹配前会移除 shell 引用，因此 `<<'PY'`、`<<"PY"` 和 `<<P'Y'` 都以 `PY` 匹配。`languageId` 必须是当前 VS Code 中已注册的语言 ID；扩展不会从 delimiter、文件内容或命令名自动猜测其他语言。将 `heredoc.enablePresets` 设为 `false` 可只使用自定义规则。

`documentMode` 可选 `auto`（默认）、`virtual`、`untitled` 或 `file`。它控制语言服务看到的临时文档形式。`auto` 优先使用虚拟内存文档；已知需要 `file:` URI 的 Bash IDE 与 Pylance 使用扩展存储目录中的临时文件。`file` 模式使用每个 VS Code 会话独立的、不可变的文件快照：正文变化后生成新文件，已打开的临时文件不会被编辑或调用保存。内容相同的快照会复用，过期快照会在转发请求结束后清理。需要特定 URI 形式的语言扩展可以通过规则指定模式。显式指定 `untitled` 可能在当前会话中留下未保存文档。

## 行为和限制

- 扩展仅处理 `shellscript` 文档中的 sh/Bash heredoc，不处理已识别为 zsh、fish 等方言的文档。正文外的 shell 代码不受本扩展改动。
- 支持 `<<`、`<<-`、引用与混合引用的 delimiter、同一行的多个 heredoc，以及映射为 shell 的 heredoc 正文中的嵌套 heredoc。`<<-` 仅忽略用于结束 delimiter 和正文的前置 TAB，不忽略空格；未引用 delimiter 的正文按 Bash 规则在判断结束行前处理反斜杠续行。
- 所有规则均由 shell 解析器确定正文边界，再通过目标语言的 TextMate 语法和编辑器装饰着色。这让着色只作用于 sh/Bash 文档中的正文；静态 TextMate 注入无法按文档方言限制。扩展会读取当前主题贡献的 TextMate、grammar 注入和语义 token 规则、主题继承及用户 token 配色设置，并预先给正文的屏幕外行着色。正文完成首次着色后，滚动进入视口不再触发重新着色。切换主题或更改 token 设置会重绘；若主题未提供可解析的规则，则使用编辑器前景色。
- 隐藏临时文档提供语义 token 的位置和类型，但 VS Code 的公开 API 不提供这些 token 最终渲染出的颜色。因此扩展依据主题规则复现着色；动态主题、第三方语义 provider 对隐藏文档的处理等因素仍可能造成与独立文件的差异。首次打开文件或刚编辑后，异步计算完成前可能短暂显示 shell 字符串色。
- 补全、悬停、定义和诊断取决于目标扩展是否安装、启用并支持临时文档。扩展会转发语言请求并映射位置；诊断只能监听目标扩展主动发布的结果，不能强制其运行。部分扩展可能只对真实文件工作，此时可尝试 `documentMode: "file"`。
- VS Code 不提供将转发请求独占交给某一扩展的接口，也不能阻止原有 shell 扩展在正文内返回结果。因此多个提供者的补全或诊断可能同时出现。
- 未引用的 heredoc 正文会按原始文本送给语言服务；脚本运行时可能发生的变量、命令或算术展开不会被预先求值。

从 `0.0.1` 升级后请重载一次 VS Code 窗口，以释放旧版本可能已打开且变脏的临时文档。新版本的文件快照不再更新已打开的临时文件。

## 开发与打包

需要 Node.js 和 npm。运行 `npm install` 后，使用 `npm run build` 编译、`npm test` 执行单元测试、`npm run test:host` 启动隔离的 VS Code 扩展宿主测试、`npm run package` 生成 VSIX。按 `F5` 可在扩展开发宿主中打开 `examples` 目录。

本机已安装 Python/Pylance、YAML 和 Bash IDE 时，可运行 `npm run test:live`。该测试在 `.vscode-test` 中创建独立配置目录，仅链接这些已安装扩展，并联调它们和 VS Code 内置 TypeScript 的补全及 YAML 诊断。可用 `HEREDOC_EXTENSIONS_DIR` 指定扩展安装目录；将 `HEREDOC_LIVE_ALL_EXTENSIONS=1` 时会使用该目录下的全部扩展，并在安装了 LimeGray 的环境中联调其活动主题颜色。目标扩展缺席时仍可用 `npm run test:host` 验证内置 Python grammar 可加载，支持高亮回退。
