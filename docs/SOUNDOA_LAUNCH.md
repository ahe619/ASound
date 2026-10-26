# soundoa.cn 上线准备

用户已确认创建 `soundoa.cn`，并选择直接使用现有仓库 [`ahe619/ASound`](https://github.com/ahe619/ASound)。域名注册完成不等于网站上线，也不代表 ICP 备案完成。

试用方案采用静态网页托管，用户首次下载模型，在自己的设备上运行。仓库工作流发布网页和按需下载的 Kokoro 量化语音包，不发布本机 Python 环境、对话模型权重或私人数据。网页运行所需的 JavaScript 会随网站公开。

经用户明确授权，当前 `ahe619/ASound` 仓库已设为公开；GitHub Pages 已创建，发布来源为 GitHub Actions，仓库变量 `ASOUND_PAGES_ENABLED=true` 已启用并核验。

平台网址预期为 `https://ahe619.github.io/ASound/`。启用发布配置不等于网页已可访问，仍需等待工作流部署成功并实际验收。`soundoa.cn` 尚未在 Pages 中绑定，本轮未配置其网站 DNS 或验证该域名的 HTTPS。没有购买或升级套餐。[GitHub Pages 可用范围](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

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

当前自定义域名尚未配置。先验收平台网址，再按下面顺序操作，不要先把域名解析到一个尚未绑定的 Pages 站点。

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

背单词可不下载任何模型。需要朗读时，只下载手机兼容语音包即可，无需对话模型和识别模型。自动模式使用已下载的 Kokoro；未下载时可回退到系统英语语音，系统语音是否联网取决于设备。高自然度 Chatterbox 依赖电脑上的 CUDA 服务，只在检测到可用服务时显示。

设置中的「网页布局」支持自动适配、手机、平板和电脑。布局选择不会改变设备能力，也不会让手机开启 CUDA。已进行多尺寸浏览器检查和电脑上的 WebAssembly 语音合成；不将模拟手机 UA 的测试当成真实手机性能测试。

网页包包含 CPU 模式需要的兼容运行库，并纳入离线版本校验，避免部分浏览器启动 CPU 模型时再临时访问外部 CDN。
这只解决兼容运行库的下载依赖，不能保证所有手机的内存、浏览器功能和推理速度都足够。

平台测试网址与正式域名是不同的网站来源，学习记录和模型缓存不会自动跨域迁移。正式邀请朋友使用时，尽量固定为通过验收后的正式域名。
