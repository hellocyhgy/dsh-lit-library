---
name: lit-library
description: Maintain a governed literature library — initialize a project, import papers, write source notes, quote verbatim, query by tags, and check library health. Use when the user adds references to a literature library, asks what a paper says, writes or revises source notes, asks which papers have a tag, or asks whether the library is clean.
---

# 文献库规则

这个技能不是讲“怎么读论文”，而是讲**怎么把你读到的内容存进库而不把它弄脏**。工具（`lit_init` / `lit_import` / `lit_find` / `lit_prefs` / `lit_check`，辅助 `lit_migrate` / `lit_repair` / `lit_undo`）负责机械操作，你负责遵守下面的规矩。

## 铁律（违反即视为错误，不是风格问题）

1. **只写“用过且核过”的内容**。资料里实际用到、并与原件或 txt 对过的段落才写进 note；不搬全文，不抄未核内容。
2. **摘录必须逐字**。中文 12–60 字、英文 8–40 词，单页，用 `「」` / `“”`（英文可用引用行里的直引号 `"…"`）包裹，后面紧跟页码（`PDF pN` / `[slide N]`）。
3. **摘录里不能嵌套引号**。实测：出现内层 `”` 会让整条摘录从体检中消失（显示 0 条摘录，不报错），比报错更危险。
4. **索引每篇 ≤ 1 行**。一句话说明“讲什么”即可；目录、参数、数据一律下沉到 note。
5. **不改已存在的编号，空号不回收**。回收会造成已有 note 断链。
6. **不编造摘录**。txt 里搜不到的句子，不能写成“原文摘录”；宁可改写成“据 pN 大意”并标注是转述。
7. **默认不入库**。用户发来文件 ≠ 让你入库。没听到明确的入库意思，就不要调用 `lit_import`；先问一句（见下）。
8. **工具只建骨架，不写笔记内容**。`lit_import` 只会写一行索引 + 一份 txt；note 必须你按六段建，内容人核。

## 入库意图（必读）

用户上传了文献、但没说要入库时，只做回答，并补一句（三个选项）：

> 要收进文献库吗？①入库 ②不入库 ③以后都不问，只有我明确说入库时才入库

- 选 ① → `lit_import({ intent: "confirmed" })`
- 选 ② → 不入库
- 选 ③ → `lit_prefs({ askBeforeImport: false })`，**以后不再问**

若 `lit_prefs` 返回 `askBeforeImport: false`：**不要提问**，只在回答末尾一行“未入库（本项目已设不问；需要入库请明确说）”；用户明确说入库时照常导。

“入库”的同义词（听到任一都算）：入库 / 放库 / 收进库 / 放进文献库 / 文献图书馆 / 文献表 / 收录 / 归档 / 存进知识库 / 加到参考文献 / 给我留一份 / 存起来。

“不算入库”：“读一下”“帮我看看”“总结一下”“这篇讲了啥”。

同一文件本会话不重复问；一次发多个文件合并问一次（“这 N 篇都要入库吗？”），肯定后用一次 `lit_import({ paths: [...] })`，逐篇报 imported / skipped / failed。

## 项目区（先确定收进哪个库）

库是按项目分的：一个工作区就是一个小库（模式 A，零参数），或 `lit-projects/<项目>/` 下多个项目（模式 B）。

- 只有一个项目时，`lit_import` / `lit_check` 可省略 `project`。
- 有多个项目并且工具报“请显式传 project”时，先用 `lit_check({ all: true })` 看列表，再指名操作。
- 跨项目引用一律写 `项目名/编号`（例：`微纳文献/A1`）。

## note 结构（六段）

```
- 原件：`refs/外部资料/<文件名>`（页/张数）
- 全文：`work/外部资料_txt/<同名>.txt`（页码定位用 `[pN]`）
- 作者 / 出处：
- 性质：（期刊 / 学位论文 / 课堂讲义 / 教材）

## 内容要点          ← 3–5 条，每条一行
## 关键参数          ← 表格；没有就写“无”
## 原文摘录（可抽查） ← ≥1 条带页码，关键数据必须有
## 用法提醒          ← 能不能引用、要不要换来源
## 注意              ← 哪里可能错（OCR 错字、上下标丢失、结论过时）
```

文件名 `<编号>_<短名>.md`，放在项目的 `refs/notes/` 下，然后把索引行的「笔记」列改成 `refs/notes/<文件名>`。

## 工作流

1. `lit_check`（多项目时 `all: true`）看现状，有 FAIL 先修。
2. `lit_import({ paths: [...], tags: [...], intent: "explicit" })` 收新文献：自动抽 txt、加一行索引。
3. 用 grep 在项目的 `work/外部资料_txt/` 里找句子（**不要整本读 PDF**）。
4. 按六段建 note，文件名 `<编号>_<短名>.md`，把索引行「笔记」列补上。
5. 写关键数据前回原件看图确认（尤其是 OCR 件）；扫描件导入时「文本」列是 `待 OCR`（不写 txt），配好 OCR 后对同一文件重导 `overwrite: true`（或 `lit_repair({ ids: [...] })`）把该行补成 `✔`，再写 note。
6. `lit_check` 再跑一次，确认没引入新 FAIL/WARN。
7. `lit_find({ tags: ["退火"] })` 按标签查文献；同标签内规范名+别名是 OR，多标签默认 AND。

## 标签（受控词表 `refs/tags.md`）

- 一篇 ≤ 5 个；索引里只写**规范名**。
- 词表里没有的标签：`lit_import` 会报错并列相近标签；确认要新增就传 `addTags: true`。
- 别名（含英文）只在查询时展开，不写进索引。

## 已知会触发 FAIL/WARN 的写法

| 写法 | 后果 |
|---|---|
| 索引行重复编号 | FAIL |
| note 不在索引里 / 索引指向不存在的 note | FAIL |
| 标签超过 5 个或不在词表 | FAIL |
| 摘录抄错一个字 | WARN（逐字回查失败） |
| 跨页拼接两句 | WARN（视为抄错） |
| 摘录超长（中文 >60 字 / 英文 >40 词） | WARN |
| note 里有数值却无摘录 | WARN |
| 摘录里嵌套引号 | WARN |

## 不要做

- 不要把正文、目录、参数表塞回索引层。
- 不要为了“看起来完整”而补没读过的段落。
- 不要改别人的编号或重排总表。
- 不要在 txt 缺失时编造页码。
- 不要在用户没说入库时“顺手”调 `lit_import`。
