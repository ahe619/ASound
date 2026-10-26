# ASound 网页发布与远程更新

当前优先发布网页版，再把同一个网站集成进手机应用。GitHub 可以承担代码管理、自动检查和网页发布；
AI 仍在用户设备运行，模型继续从 `app/packs.json` 配置的 Hugging Face / 镜像下载源获取。

## 已接好的更新流程

```text
修改代码 → 推送 main → GitHub Actions 检查 → 构建完整网页发布包 → GitHub Pages
                                                                       ↓
用户打开应用或检查更新 → 后台下载变动文件并校验 → 设置提示新版 → 点击更新后重新打开
```

- `tools/build_web.py` 生成 `dist/web/`，不包含本地模型、Python 环境或开发页面。
- 每个发布文件都有 SHA-256；版本标识由 `VERSION`、全部发布资产和 service worker 代码共同决定。
- 安装阶段验证完整文件集，未改动的大型运行库可以复用旧缓存。下载失败或校验失败不替换可用版本。
- 新版准备好后等待用户点击，或等待旧版的全部窗口关闭。不会在用户练习过程中主动刷新。
- 手动更新时，若仍在练习或还开着另一个 ASound 窗口，会提示先结束练习或关闭其他窗口。
- 应用缓存按网站路径隔离，保留上一份完整缓存；不会删除模型缓存、OPFS 模型文件或 localStorage 学习记录。
- 正常打开网站会检查更新；已打开的可见窗口每小时检查，恢复联网时也会检查。应用完全关闭且离线时，
  无法立即获取远程发布；下次联网打开时再检查。

## 第一次发布到 GitHub

1. 准备一个 GitHub 仓库，默认分支使用 `main`。
2. 将源码纳入版本控制并推送到该仓库。已提供 `.gitignore`，排除模型、虚拟环境、exe、build 和 dist。
   `app/vendor/`、字体和许可文件需要保留，它们是网页运行时的一部分。
3. 在 GitHub 仓库打开 **Settings → Pages → Build and deployment → Source → GitHub Actions**。
4. 在 **Settings → Secrets and variables → Actions → Variables** 添加仓库变量
   `ASOUND_PAGES_ENABLED`，值设为 `true`。未设置时只检查和构建，不部署网站。
5. 推送到 `main`，或在 Actions 手动运行 **Check and publish ASound web**。
6. 检查工作流通过后，使用 Pages 返回的网站地址。项目仓库通常形如
   `https://<用户名>.github.io/<仓库名>/`；代码与资源路径支持这种子目录部署。
7. 在手机打开该网址并添加到主屏幕。首次先完成应用离线缓存和模型下载，再验证断网使用。

GitHub Pages 的免费可用范围与仓库可见性取决于账号方案。是否公开源码应在创建仓库时明确选择；
这份配置不会替你改变仓库可见性。默认工作流仅部署 `main`，PR 运行检查而不发布。

## 日后怎么更新

修改代码并推送 `main` 即可触发发布。建议同时递增根目录的 `VERSION`，例如 `0.2.0` 到 `0.2.1`；
构建器还会添加内容 hash，避免忘记改版本号时用户收不到更新。无需让用户重下模型或整个手机安装包。

发布前本地执行：

```powershell
.\.venv\Scripts\python.exe tools\check_i18n.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
node tools/check_js.mjs
node --test tests/*.mjs
.\.venv\Scripts\python.exe tools\build_web.py
.\.venv\Scripts\python.exe -m http.server 8782 --directory dist/web
```

然后访问 `http://localhost:8782/`。浏览器允许 localhost 测试 service worker；实际手机访问需要 HTTPS。
直接部署 `app/` 会跳过发布清单生成，不能获得这套完整的离线更新保证。

下载校验可以防止缺文件或发布途中混入不同版本，但不能代替功能测试。若新版本功能有问题，
在 GitHub 回退对应提交并重新发布；客户端会把回退构建识别为另一次更新。保留的旧缓存供文件复用，
不是自动判断应用逻辑故障的回滚系统。本次未改变用户数据结构，未来变更数据结构需要兼容迁移。

尽量固定正式域名。浏览器学习记录和模型按网站来源存储；更换域名后不能自动读取原域名的数据。

## 手机软件怎么接

| 形态 | 网页更新是否直接生效 | 另外需要发布什么 |
|---|---|---|
| 主屏幕 PWA | 是，使用本次更新机制 | 无独立 APK/IPA |
| Android Trusted Web Activity | 加载同一网站时，可沿用 PWA 更新 | 原生配置、权限等改变仍需新签名 APK/AAB |
| 当前 Android WebView 壳 | 否，目前加载打包在 APK 内的网页 | 更新 APK，或先改造成受信任的远程网站架构 |
| 当前 iOS WKWebView 壳 | 否，目前加载本地打包网页 | Xcode 编译、真机验证及相应分发流程 |

Android 下一步建议测试 Trusted Web Activity：由浏览器运行已发布的网站，通过 Digital Asset Links
证明网站和手机包属于同一开发者；这比直接假定所有手机 WebView 都支持同样的 WebGPU 更稳妥。
当前 Android/iOS 壳本次未切换到远程网址，也没有生成或上架手机安装包。

iPhone 先用主屏幕 PWA 验证模型内存、响应时间和录音。App Store 应用不能只假定“套个网页壳就能通过审核”，
还需满足 Apple 对功能与体验的要求；原生代码和权限变更按正常应用发布流程处理。

## 托管边界和资料

GitHub Pages 用于本项目的静态网页，无法运行 `server.py`，因此网页版使用浏览器内的 AI 和语音运行时。
Pages 当前网站上限 1 GB、月流量软限制 100 GB；模型权重不放进 Pages。若未来收费运营或需要更多容量，
应核对 Pages 使用政策并选合适的正式托管；当前生成的 `dist/web/` 可以迁移到其他 HTTPS 静态托管。

- [GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub Pages 使用限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [Service worker 生命周期与更新等待](https://web.dev/articles/service-worker-lifecycle)
- [Android Trusted Web Activity](https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities)
- [Apple App Review Guidelines 4.2](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality)
