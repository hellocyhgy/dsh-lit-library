---
name: lit-ocr-setup
description: 给文献库配扫描件 OCR（poppler 栅格化 + 本地 OCR 引擎），或者排查“装了 OCR 但 lit_import 仍写「待 OCR」”。当用户说“扫描件读不了 / 待 OCR / 帮我配 OCR / OCR 装了没用 / 扫描 PDF 入库没文本”时使用。
---

# 扫描件 OCR 现场配置（Agent 执行剧本）

文献库插件**本体不包含 OCR 引擎**：它只负责“把扫描页变成图片 → 调你配的外部命令 → 把结果写进 txt”。
所以“能不能读扫描件”完全取决于三件事：

1. `pdftoppm`（poppler）能把 PDF 页栅格化成 PNG；
2. 有一个 OCR 命令能吃 `图片 + 输出路径`；
3. `.lit.json` 里的 `ocr.command/args` 指向上面的命令。

这三件事由**你（Agent）现场完成**，不是用户手写配置。用户只需要说“扫描件读不了”。

---

## 第 0 步：先判定到底缺哪一环

不要一上来就装东西。先跑三个探测（本机命令名以实际为准）：

```bash
pdftoppm -v            # 注意：poppler 只认 -v，不认 --version
tesseract --version    # 可选引擎
python -c "import rapidocr_onnxruntime; print('rapidocr ok')"   # 可选引擎
```

再看文献库怎么看这件事：

```
lit_prefs({ detectOcr: true })
```

返回里三项都对上（`pdftoppm` ok、已写 `ocr.command` 或至少一个引擎 ok），直接跳到**第 4 步写配置**。
缺哪项修哪项，**不要三项都重装**。

> 注意两个已知假阴性：
> - 引擎装在项目内自定义目录（如 `pip --target work/pylibs_ocr`）时，`python -c "import rapidocr_onnxruntime"` 看不到它，这是正常的；**已写 `ocr.command` 时以实测为准**（第 5 步），不要因此判定“引擎没装”。
> - `pdftoppm` 只认 `-v`，`--version` 会报错——探测时别用 `--version`。

---

## 第 1 步：装 poppler（pdftoppm）

### Windows
- **先试官方**：`winget install oschwartz10612.Poppler`。
- 国内网络常见失败（`InternetOpenUrl() failed` / `0x80072efd`），改镜像：
  ```
  https://ghfast.top/https://github.com/oschwartz10612/poppler-windows/releases/download/<tag>/Release-<tag>.zip
  ```
  或换其它 GitHub 镜像；**不要写死镜像域名，按当时可用的选**。
- 解压后把 `Library\bin` 加入 PATH（用户级即可），并**记住这一步**：PATH 改动只对新进程生效。

### macOS / Linux
- `brew install poppler` / `apt install poppler-utils`。

**验证**：`pdftoppm -v` 能打印版本号。
**常见坑**：装完但当前 dsh 进程说“没装”——因为进程早于 PATH 改动启动。此时**重启 dsh 或让用户在终端里跑一次验证**，不要去改插件代码。

---

## 第 2 步：准备 OCR 引擎

首选 **RapidOCR（onnx，离线、自带模型、中英）**，不联网、不依赖系统服务：

```bash
python -m pip install --target <项目内目录，例 work/pylibs_ocr> \
  -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr-onnxruntime
```

- 装到**项目内目录**而不是全局 site-packages：可随项目迁移，不污染系统。
- 国内 pypi 慢就用镜像（tuna / 阿里均有）。

也可以用 tesseract（`-l chi_sim+eng`），但 Windows 上要额外装语言包，**优先 RapidOCR**。

---

## 第 3 步：写引擎包装脚本

插件只要求一个契约：**读一张图，把纯文本写到指定路径**，命令行形式：

```
<engine command> <args...>   其中 args 里用 {input} / {output} 占位
```

RapidOCR 的最小包装（示例脚本 `ocr_engine.py`，路径随项目）：

```python
import sys
sys.path.insert(0, r'<项目内 pylibs_ocr 的绝对路径>')
from rapidocr_onnxruntime import RapidOCR

inp, outp = sys.argv[1], sys.argv[2]
res, _ = RapidOCR()(inp)
lines = [x[1] for x in res] if res else []
open(outp, 'w', encoding='utf-8').write('\n'.join(lines))
```

注意：
- 输出必须写 `{output}` 文件；写 stdout 插件也能读，但文件更稳。
- Windows 控制台是 GBK，脚本里别用 `print` 打中文；要打就设 `PYTHONIOENCODING=utf-8`。

---

## 第 4 步：写配置（只改项目文件）

写进项目根的 `.lit.json`（不要改插件代码）：

```json
"ocr": {
  "command": "<python 可执行文件绝对路径>",
  "args": ["<ocr_engine.py 绝对路径>", "{input}", "{output}"],
  "timeoutMs": 300000
}
```

- 默认栅格化参数是 `pdftoppm -r 200 -png`（200 dpi），**不要自作聪明改 dpi**：同一库里混用不同 dpi 会让 OCR 质量不一致。
- 路径用正斜杠或双反斜杠；Windows 路径带空格也没关系（进程直接 spawn，不经 shell）。

---

## 第 5 步：自测（必须做，不要声称成功）

按成本从低到高：

1. `lit_prefs({ detectOcr: true })` → `ocrConfigured` 应为 `true`。
2. 拿**一页**扫描页验证链路的每一段：
   ```bash
   pdftoppm -r 200 -png -f 1 -l 1 <扫描.pdf> /tmp/probe
   python <ocr_engine.py> /tmp/probe-1.png /tmp/probe.txt
   ```
   能出中文就说明前两段好。
3. 真正入库一篇小扫描件（或对已有「待 OCR」行跑 `lit_repair({ ids:[...] })`），确认索引文本列从 `待 OCR` 变成 `✔`。

**没跑通第 3 步就不要告诉用户“配好了”。**

---

## 第 6 步：失败时怎么收场

允许部分成功，**不允许假装成功**：

- 装不上引擎 → 保持「待 OCR」，告诉用户“需要网络/管理员权限”，并给出下次可重试的一句话；
- poppler 装了但当前进程看不见 → 让用户重启 dsh；
- OCR 质量差 → 说明是识别率问题，不是配置问题；提醒“引用必须回原页看图”。

---

## 不要做

- 不要为了一篇文献去改插件源码（除非用户明确要求改产品）。
- 不要把 PATH 改动当成立马生效——进程早于改动启动就用不到。
- 不要把 `pdfimages`、`pdftotext` 当成能出文本：它们对**无文本层的扫描件**没用，必须栅格化 + OCR。
- 不要在用户没说“要 OCR”时自动下载安装几十 MB 的东西：先探测、再报告代价、得到同意再装。
