# 背单词模块的数据来源

本模块使用可追溯的静态词表和词典词项，考试成员、释义、音标不由语言模型生成。默认不需要下载 AI 模型即可浏览、记忆单词；朗读仍使用应用已有的语音能力。

## 四级与六级

考试分类依据教育部教育考试院网站列出的[《全国大学英语四、六级考试大纲（2016 年修订版）》](https://cet.neea.edu.cn/xhtml1/folder/16113/1588-1.htm)，取其[官方 PDF](https://cet.neea.edu.cn/res/Home/1704/55b02330ac17274664f06d9d3db8249d.pdf)的词表部分（PDF 页 21–149）。

- 大纲的星号标记用于区分六级新增词，未标星的基础词进入四级；六级词库同时包含基础词和六级新增词。
- 词表同一行右侧明确列出的派生词沿用所属主词的分类，拼写变体按原文的斜杠、括号记法展开。
- 同形词在产品中合并，例如 `appropriate` 既有基础词目，也有六级义项；它可以进入两类，但词典中的所有释义不因此都属于四级要求。`appropriation` 在标星义项旁，单独归入六级。
- `according to`、`owing to`、`baby boom`、`baby boomer` 这类短语会恢复 PDF 文本抽取丢失的空格；`connection/-xion` 按大纲前言明确给出的 `connexion` 处理。没有依据的拼写或词义不补造。

定义和音标取自 ECDICT 的准确词条匹配。为了保留词义和音标的可核对性，没有定义匹配的词形不进入学习卡片，记录在 `app/vocabulary/coverage-report.json`。如 `cliché`、`résumé` 缺少精确词条匹配，不直接挪用其他重音或词义的音标。

页面收录数量包含派生词和拼写变体，因此会高于常见的主词目数量。官方文件自报 5418 个词目；抽取索引保留 5377 个主栏行和关联派生词，随后合并同形词、展开原文变体。**这些计数不能作为完整覆盖官方词表的证明，本版未标称“官方完整词库”或“最新年度全量大纲”。** 词表、释义覆盖与缺口都能从随包索引和报告核查。

## 考研

考研参考库严格取 [ECDICT](https://github.com/skywind3000/ECDICT) 的 `ky` 标签，当前固定版本共有 4801 个带中文释义的匹配词项，没有通过 AI 补足到某个宣传词数。

该标签是上游公开词库的备考分类，不是教育考试主管部门对本应用的认证。当前尚未完成与当年英语一／英语二完整大纲的逐词比对，所以界面称“考研词汇（参考）”，不能当作唯一备考词表。未来替换考研分类时，需使用来源与使用许可明确的新版词表，并保留逐项差异报告。

## 词典、音标与通用词

ECDICT 固定到提交 `ab22ad36302cafc6349a050e2b60894855208055`，使用其 `ecdict.csv` 中的原始 `translation`、`phonetic` 和 `tag` 字段。其[字段说明](https://github.com/skywind3000/ECDICT/tree/ab22ad36302cafc6349a050e2b60894855208055)解释了考试标签、BNC 和当代语料库词频；音标以英式为主，实际朗读口音取决于应用选用的声音。

上游仓库以 MIT 许可证发布；原文保留在 `app/vocabulary/ECDICT-LICENSE.txt`，不能因为应用保持私有而移除此许可通知。MIT 说明对应 ECDICT 数据；官方词表分类另保留来源链接与页面索引，不冒称官方 PDF 采用 MIT。

日常词库使用 ECDICT 中 BNC 或当代语料库排名 1–3000 的有中文释义词项，再与 `contexts.json` 的人工主题／场景词汇取并集。
频率池会排除释义明确标注“男子名、女子名、人名、姓氏、男性名、女性名、男名、女名”的词，避免随机学习频繁出现单纯人名；主题／场景人工白名单可覆盖此排除，例如实际需要的 `North`。
具体被排除的词列于覆盖报告 `generalExcludedPersonalNames`。这项过滤只影响日常自动选词，考试成员仍严格按其来源判定，不会因人名标签或词长而擅自修改。

## 文件与再生成

运行时文件都在 `app/vocabulary/`：

- `words.json`：学习卡片所需的词项、释义、音标、分类与上下文标签。
- `catalog.json`：各词库实际词数、来源、版本、校验值和覆盖说明。
- `cet-2016-index.json`：从官方 PDF 抽取的词形事实，带页码、原始拼写记法和星号归属。
- `coverage-report.json`：未匹配的官方词形、考研标签匹配数量与主题词匹配结果。
- `contexts.json`：可选主题和场景的人工分类。
- `ECDICT-LICENSE.txt`：上游许可通知。

首次在维护环境下载固定数据并再生成：

```powershell
.\.venv\Scripts\python.exe -B tools/prepare_vocabulary.py --download
```

原始大 CSV 和许可文件只存放在 `build/vocabulary-source/`，不会被打入网站。以后可以离线再生成：

```powershell
.\.venv\Scripts\python.exe -B tools/prepare_vocabulary.py
```

生成器校验固定 commit 的 CSV SHA-256、许可文件 SHA-256、已审查 CET 索引 SHA-256，然后输出词库。若来源哈希变化会停止，不能静默换用新数据。

维护者可额外核验官方 PDF：使用装有 `pypdf` 和 `pdfplumber` 的 Python 执行：

```text
python tools/prepare_vocabulary.py --verify-cet-pdf build/vocabulary-source/cet-2016.pdf
```

此选项会核对官方 PDF SHA-256，再依据固定版面的主栏位置和星号位置、普通文本中的完整词形重建索引，并检查结果与提交的索引逐字节一致。PDF 解析器只用于数据维护，不是网页或常规发布构建的运行依赖。

本次还对 PDF 页 21、22、26、40、41、80、81、148、149 的 79 个可见星号做了独立抽样检查；跨页 `check²/cheque` 与 `appropriate² / appropriation` 的分类均与原页一致。此抽样不能代替完整内容审核。
