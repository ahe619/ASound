# soundoa.cn 上线准备

用户已确认创建 `soundoa.cn`，并选择直接使用现有仓库 [`ahe619/ASound`](https://github.com/ahe619/ASound)。域名注册完成不等于网站上线，也不代表 ICP 备案完成。

试用方案采用静态网页托管，背单词打开即可使用；需要额外功能时再按需下载模型，在自己的设备上运行。仓库工作流发布网页和按需下载的 Kokoro 量化语音包，不发布本机 Python 环境、对话模型权重或私人数据。网页运行所需的 JavaScript 会随网站公开。

经用户明确授权，当前 `ahe619/ASound` 仓库已设为公开；GitHub Pages 已创建，发布来源为 GitHub Actions，仓库变量 `ASOUND_PAGES_ENABLED=true` 已启用并核验。

正式入口为 `https://soundoa.cn/`，默认项目网址 `https://ahe619.github.io/ASound/` 会跳转到正式域名。截至 2026-10-26，Actions 部署、域名绑定、主域名证书与强制 HTTPS 均已核验；首次访问、下载声音包和实际语音合成后的独立 Chrome 检查均为安全连接，未发现 HTTP 子资源。`www.soundoa.cn` 的 DNS 已通过 GitHub 检查，但现有证书暂未包含该名称，尚未通过 HTTPS 验收，分享时使用不带 `www` 的入口。未购买或升级套餐。[GitHub Pages 可用范围](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## 构建与上传

在项目根目录生成并验证网页发布包：

```powershell
.\.venv\Scripts\python.exe tools\prepare_soundoa_site.py --with-web-voice
```

构建出的网页位于 `dist/soundoa-site/site/`。源码仓库根目录的 `.github/workflows/pages.yml` 会执行同一构建命令，并仅将该网页目录交给 Pages；它不上传整个仓库作为网站。

把审核后的源码、运行库、测试和构建配置提交到已有 `ahe619/ASound` 的 `main` 分支。`.gitignore` 已排除模型、Python 环境、`build/` 和 `dist/`。无需提交生成的 `dist/`，也不需要新建仓库。

`dist/ASound-soundoa-ready-0.3.1.zip` 保留为便携交付包。解压后的 `soundoa-site/site/` 可用于本地预览或其他静态托管平台；`instructions/` 是操作说明。包内的 README 和预构建产物工作流适用于独立的产物仓库，**不要用它们覆盖已有 ASound 源码仓库的 README 或工作流**。生成 ZIP 只完成准备，不会发布网站。

截图中的 15 元 AI 建站套餐不是本方案的必需项，先不用加购。[万网活动页](https://wanwang.aliyun.com/newactivity/benefits?tid=newCustomer)
将它列为配有云资源和赠送域名权益的 AI 建站产品；计费周期和续费价需以具体订单为准。未核实其导入已有应用的限制，不能确认它是否能直接承载 ASound 的 JavaScript、WASM 和离线网页功能。

## 先验证平台网址

1. [`ahe619/ASound` 的 Settings → Pages](https://github.com/ahe619/ASound/settings/pages) 已创建站点并选择 **GitHub Actions** 作为发布来源。
2. **Settings → Secrets and variables → Actions → Variables** 中的仓库变量 `ASOUND_PAGES_ENABLED` 已设为 `true`。将来若关闭该变量，工作流只检查和构建。
3. 推送到 `main`，或在 Actions 手动运行 **Check and publish ASound web**，等待构建、检查和部署成功。PR 和其他分支不会部署网站。
4. 使用 Pages 设置页实际返回的 HTTPS 地址验收。默认项目地址预期为 `https://ahe619.github.io/ASound/`；这是预期地址，只有部署成功并实际访问后才能确认上线。
5. 检查首页、背单词、模型下载入口、录音权限和更新提示，并让目标手机实际完成一次下载和对话。GitHub Pages 与模型镜像在中国大陆的可达性仍需分别测试。

GitHub Free 支持公开仓库的 Pages，Pages 可托管 HTML、CSS、JavaScript 等静态文件。[GitHub Pages 说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## 后续如何更新

在现有源码仓库修改、检查后推送 `main`。Pages 权限和 `ASOUND_PAGES_ENABLED` 都已配置时，Actions 会重新构建并更新网站；应用内的更新机制会提示用户安装新版，模型和学习记录保留在同一网站来源下。
不要直接修改生成的 `site/` 文件，它们的内容必须与发布校验清单一致。只生成本地 ZIP，或在部署尚未启用时推送源码，都不会改变公开网站。

此免费托管方案用于当前试用；若以后收费运营，需重新核对托管政策和用量。Pages 只额外托管约 101 MB 的 Kokoro 量化语音包，作为单独的按需下载文件；对话和识别模型继续使用外部下载源。
[GitHub Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

## 绑定 soundoa.cn

自定义域名已绑定，四条 A 记录与 `www` CNAME 已核验。以下保留为重新配置时的步骤；正常更新网页只需发布代码，无需重复修改域名。账号级域名所有权 TXT 验证未在本轮核实，不将站点绑定视为所有权验证完成。

1. 在 GitHub **个人账号 Settings → Pages → Add a domain** 添加 `soundoa.cn`。
2. 按 GitHub 实际显示的名称和值，在域名解析控制台添加所有权验证 TXT 记录。通常记录名形如 `_github-pages-challenge-ahe619`；**记录值必须从当前账号页面复制，不能自行填写或猜测**。解析生效后回 GitHub 点击 Verify，验证成功后保留 TXT。
3. 在 **`ahe619/ASound` 仓库 Settings → Pages → Custom domain** 填入 `soundoa.cn` 并保存。
4. 再配置下面的网站解析记录。操作前查看已有同名记录，只处理确认冲突的网站记录，保留邮件、其他 TXT 验证等无关记录；不要添加 `*` 泛解析。

| 类型 | 主机记录 | 记录值 |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `ahe619.github.io` |

`www` 的记录值不加 `https://`，也不加 `/ASound/`。以上为本次核对的 GitHub Pages 官方值，实际配置前可再核对。[域名绑定和 DNS 记录](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)

域名所有权验证在个人账号设置中，站点域名绑定在仓库设置中，两者都要完成。[域名验证](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages) 使用自定义 Actions 发布时，GitHub 不依赖发布文件中的 `CNAME`；仅放置该文件不能替代仓库 Pages 设置。[自定义域名设置](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)

## HTTPS 与最终验收

GitHub Pages 支持自定义域名的 HTTPS，无需为这条发布路线另买证书。DNS 正确后等待 GitHub 签发证书，再启用 **Enforce HTTPS**。DNS 传播和该选项就绪可能需要等待，不能把保存设置当作 HTTPS 已可用。[HTTPS 设置](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

确认 `https://soundoa.cn/` 正常打开、`www` 能到达同一站点，并在手机检查：

- 首次完整下载与中断后的继续下载；GPU 推荐组合约 587 MB，CPU 回退组合约 696 MB，网页资源另计。
- 完整缓存后的断网启动、录音与连续对话；手机速度尚不能由电脑测试保证。
- 发布新版本后，更新提示与手动更新是否正常。

Kokoro 量化语音包由网站同源提供，20 个文件均校验 SHA-256，用户主动下载后保存在浏览器里。网页更新不会自动下载这 101 MB；语音包版本变化时使用新的缓存标识。CI 用 `--download-web-voice` 从固定上游版本取文件，构建失败时不会发布。完整许可证随网页提供。

没有安装对话资源的新网页用户默认直接进入背单词，不需要先下载模型。手机自动朗读优先使用已有的系统英语语音；选择自然音色，或设备没有可用系统英语声音时，可使用下载的 Kokoro 声音包。桌面自动模式保留声音包优先顺序。基础朗读无需对话模型和识别模型，系统语音是否联网取决于设备。高自然度 Chatterbox 依赖电脑上的 CUDA 服务，只在检测到可用服务时显示。

网页及手机上的对话模型按实际请求启动，手机进入页面时不预加载识别模型。复述故事在手机或未安装对话模型时使用内置故事，可直接通过文字完成练习；语音识别只在用户开始录音后准备。下载完成不等于模型已初始化，也不能保证每部手机的实时推理速度。

顶部外观按钮可切换跟随系统、白天、黑夜，单独保存到 `asound.theme.v1`；与学习记录和模型缓存分开。界面以功能、下载体积和状态说明可选内容，硬件兼容由应用检测处理。

背单词支持翻卡记忆、释义选择题和拼写强化。选择题与拼写按真实提交结果记录正误；拼写可用手机键盘和回车提交，草稿及答后反馈随练习保存。三种模式共用原词库和主题／场景筛选，均不需要下载 AI 模型，也不产生模型调用费用。首批 AI 插画仅覆盖 bridge、harvest、balance，在揭晓或提交答案后显示；其余词正常学习，不用示意图冒充所有词的含义。生成说明见 `docs/VOCABULARY_ILLUSTRATIONS.md`。

浏览器返回与手机系统返回逐级恢复上一页，包括学习选择、题卡、设置和下载管理；前进、刷新后的当前步骤及草稿也会保留。在入口处仍可正常离开网站。退出录音或对话页面会停止麦克风与朗读，未完成的识别结果不会回写已经关闭的复述练习。

设置中的「网页布局」支持自动适配、手机、平板和电脑。布局选择不会改变设备能力，也不会让手机开启 CUDA。已进行多尺寸浏览器检查和电脑上的 WebAssembly 语音合成；不将模拟手机 UA 的测试当成真实手机性能测试。

网页包包含 CPU 模式需要的兼容运行库，并纳入离线版本校验，避免部分浏览器启动 CPU 模型时再临时访问外部 CDN。
这只解决兼容运行库的下载依赖，不能保证所有手机的内存、浏览器功能和推理速度都足够。

平台测试网址与正式域名是不同的网站来源，学习记录和模型缓存不会自动跨域迁移。正式邀请朋友使用时，尽量固定为通过验收后的正式域名。
