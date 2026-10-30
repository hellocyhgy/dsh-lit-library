# dsh-lit-library

把论文收进一个**不会变脏**的索引：导入、抽全文、加一行索引，并保证每一条摘录都能字面查到。

库是**分项目区**的：一个项目一个完整小库，顶层一张总览。这样不同课题的文献各管各的，索引预算互不挤压。

这不是 PDF 阅读器，也不是文献检索。它只做一件事：让文献库在你反复使用后仍然可检索、可核对、不膨胀。

## 它解决什么

用 AI 读论文最常见的问题不是“读不懂”，而是：

- 读了十几篇，过一周就找不到哪篇讲了什么；
- 笔记里写的数字，回原文对不上；
- 索引越写越长，最后谁也不看。

本插件把这三件事变成可机械检查的：**索引有预算、摘录要逐字、笔记路径不能断**。

## 工具

| 工具 | 作用 |
|---|---|
| `lit_init project=<名>` / `register=<旧库根>` | 建项目区；或原地接管旧库（只写 `.lit.json`，不动原件/txt/notes） |
| `lit_import project=<名> paths=[...]` | 导入文献：去重 → 抽文本（扫描件需配 OCR 命令，未配则登记「待 OCR」）→ 预算预检 → 追加一行索引 |
| `lit_find tags=[...]` | 按标签查文献（同标签内规范名+别名 OR，多标签默认 AND） |
| `lit_prefs` | 读/改项目偏好（askBeforeImport、预算、页偏爱等） |
| `lit_check project=<名>` 或 `all=true` | 体检：索引超限、孤儿 note、断链、摘录逐字回查；`all` 还核对顶层总览 |

辅助：`lit_repair`（补 OCR / 重试失败行）、`lit_migrate`（单表 → 分片）、`lit_undo`（用 `.bak` 回滚最近一次写索引）。

另带一个 Skill，告诉模型“什么该写进笔记、什么算核过”。

## 安装

在 DSH 的插件管理里安装本包（把 `dsh-lit-library` 加进 profile 的 `dsh.profile.bundles`，或用插件管理器的 install_bundle）；装好后重启 DSH，8 个工具与内嵌 Skill `lit-library` 生效。

需要 DSH `>=0.2.0-rc.2`。主体是纯 Node（unpdf + fflate）；**扫描件 OCR 才需要外部命令**：默认用 `pdftoppm` 栅格化 + 你配置的 OCR 引擎（`ocr.command/args`），不配就登记「待 OCR」，不会假装成功。

扫描件 OCR 配置示例（项目 `.lit.json` 或 profile 的 `lit-library` config 里）：

```json
{
  "ocr": {
    "command": "<python>",
    "args": ["<ocr_engine.py>", "{input}", "{output}"],
    "timeoutMs": 120000,
    "render": { "command": "pdftoppm", "args": ["-r", "200", "-png", "{input}", "{outdir}/{prefix}"] }
  }
}
```

`{input}`/`{output}` 是单页图片与 OCR 文本输出；`{outdir}`/`{prefix}` 是栅格化输出目录与文件名前缀。真实环境已用 `pdftoppm` + RapidOCR（`ocr_engine.py`）验证：一页扫描件能抽出带 `===== [p1] =====` 页标的中文 txt。

## 第一次使用

```
lit_init project=我的课题      # 建项目区
lit_import project=我的课题 paths=[D:\papers\xxx.pdf]
lit_check project=我的课题     # 应该 0 FAIL / 0 WARN
```

多个课题就建多个项目区：`lit-projects/我的课题/`、`lit-projects/另一个课题/`，各有各的索引与编号。

## 它能做什么 / 不能做什么

| 能做 | 不能做 |
|---|---|
| 电子版 PDF 的文本层抽取，逐页页标 | 扫描件：需自己配置一个 OCR 命令（配置后可用；未配置会登记「待 OCR」并提示安装） |
| 带预算的索引追加 | 旧的 `.ppt`（需先另存为 PDF） |
| 摘录逐字回查与嵌套引号检查 | 自动写笔记内容（内容必须人核） |
| 孤儿 note / 断链检查 | Web 界面（纯工具 + Skill） |
| 多项目区隔离，各自编号不串 | 跨项目自动汇总（只提供 `项目/编号` 引用写法） |

## 配置

默认值已经能跑；需要时在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: lit-library
  config:
    projectsRoot: lit-projects
    origDir: refs/外部资料
    txtDir: work/外部资料_txt
    notesDir: refs/notes
    indexFile: refs/参考资料总表.md
    maxBytes: 8192        # 索引字节预算（项目级可在 .lit.json 覆盖）
    maxEntries: 150       # 篇数安全阀
    maxTxtBytes: 1048576  # 单篇 txt 安全阀
    shardEntries: 200     # indexMode: sharded 时每片条数
```

项目根默认取**当前会话的工作区**，不需要手写；多项目工作区才需要传 `project` 名字。

## 两个设计取舍（提前说清楚，免得意外）

1. **索引是有预算的**（行数与字节）。超了会**拒绝写入**而不是截断，并提示把细节拆到 note。这是故意的：索引一膨胀就没人看。
2. **摘录必须字面存在**。遇到嵌套引号、跨页拼接、抄错一个字，体检都会报——包括一种很难发现的：“整条摘录从检查中消失”（体检显示 0 条）。后者需要插件自身的额外规则才能捕获，我们加了。

## License

MIT
