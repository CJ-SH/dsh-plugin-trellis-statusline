# dsh-plugin-trellis-statusline

[English](README.md) | 中文

在 dsh 网页版聊天里显示当前工作区正在进行的 [Trellis](https://github.com/mindfold-ai/Trellis) 任务——终端里 Claude Code 的 `statusline.py` 钩子做的那件事，也是 dsh 网页外壳原本没有的状态行。

## 功能

- **会话头部**：会话预设选择器右侧，一枚常驻的任务胶囊。
- **新会话视图**：第一条消息尚未发出时，胶囊出现在输入卡片正上方的 composer 停靠行，与用量胶囊共用一行。
- 胶囊读作 `[优先级] 标题 · 状态`，并标出该任务在任务树中的角色（父任务 / 子任务）。
- 任务属于一棵树时胶囊可点击，下拉里按真实结构缩进展示任务树，并高亮当前会话的任务。
- 只读：从不写入 Trellis，不启动、不切换、不归档任何任务；工作区没有任务时什么都不显示。
- 会话没有自己的任务时，显示工作区的活动任务**数量**，绝不显示别的会话的任务。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-trellis-statusline
```

### 从本地目录安装

```bash
git clone https://github.com/CJ-SH/dsh-plugin-trellis-statusline
dsh plugin --profile web add ./dsh-plugin-trellis-statusline
```

安装后请**重启 dsh**——插件在启动时加载，重启会结束正在运行的 agent 进程，所以请自行执行。无需任何配置。

## 使用

胶囊在会话头部（会话预设选择器右侧）；新会话里则在输入卡片正上方的停靠行。四种形态：

```
[P2] Add the importer · 进行中
[P1] Release 0.2 · 进行中 · 父任务
[P2] Wire the importer · 进行中 · 子任务
工作区 3 个活动任务
```

- 独立任务：`[P2] 标题 · 进行中`，无角色、不可点击、不进 Tab 焦点。
- 任务树的根：`[P1] 标题 · 进行中 · 父任务`；树中其他成员（含孙节点）：`... · 子任务`。
- 会话没有自己的任务但工作区有：`工作区 N 个活动任务`，只带一枚列表图标，无标题、无角色。

显示每 10 秒刷新一次，切换会话时立即刷新，因此 `task.py start` / `task.py archive` 会在一次轮询内出现。

配置：无。插件读取它所渲染的那个会话，不含任何设置。

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-trellis-statusline
```

不存任何数据，卸载无需清理。

## 技术说明

- 需要 dsh `0.2.0-rc.1` 或更新的 `0.2.x`，且使用 `web` profile；版本不匹配时该行在启动时被拒绝并给出提示，而不是加载一个席位已经移位的插件。
- 需要 Node `^22.19.0 || >=24.0.0`。
- 需要一个 Trellis 托管的工作区：在其中运行 `trellis init --dsh`，会话工作目录里便有 `.trellis/`，这也是插件唯一读取的东西。
- 运行时不依赖 Python，也不需要 `trellis` CLI——只读 Trellis 写出的 JSON。
- 胶囊标题截断到 48 个字符，任务树下拉里的行不截断；所依赖的席位是 dsh 内部实现，升级 dsh 可能移动它们。

## 深入阅读

契约、排障与内部结构见 [docs/design-notes.md](docs/design-notes.md)。

## License

MIT © 2026 HenTaiCJN
