# 国内声音下载接入准备

当前只准备接入能力和本地上传包：没有开通 OSS/COS，没有上传文件，没有配置真实镜像地址，也没有验证国内提速。网站仍可使用原来的下载地址。对象存储后续会产生存储、请求和出网费用，具体按所选服务计费；本次工具不购买服务、不读取云账号密钥。

此次准备位于 `codex/domestic-download-prep` 分支，版本为 **0.3.6，尚未发布**；当前线上版本仍为 **0.3.5**。仅给现有线上工作流设置变量不会启用尚未发布的接入代码。

该方案只为现有自然声音模型、5 个声音运行文件和 16 个短试听音频增加下载来源。模型仍在用户设备运行，不会变成云端推理，不包含对话或识别模型，也不保证改变手机生成声音的速度。

## 先生成上传包，无需域名

在仓库根目录执行：

```powershell
python tools/prepare_soundoa_site.py --with-web-voice
python tools/prepare_download_mirror.py
```

第一条命令要求本地已有校验通过的语音权重；缺失时会报错，不会偷偷下载。需要主动补齐固定版本时才使用 `--download-web-voice`。第二条命令默认验证 `dist/soundoa-site/site/` 中每个网页资源及固定语音权重，再生成：

| 文件或目录 | 用途 |
|---|---|
| `dist/domestic-downloads/payload/` | 将目录内部内容上传到下载根目录，保留全部子目录 |
| `dist/domestic-downloads/upload.zip` | 与 payload 内容相同的便携包；解压后上传，不能只把 ZIP 上传当作资源 |
| `dist/domestic-downloads/manifest.json` | 操作者清单：来源路径、对象键、大小、SHA-256、建议 MIME/缓存头和未上传状态 |

工具只选固定语音模型、声音运行文件、试听和相关许可/来源说明，不复制应用页面、其他模型、后端、凭据或用户数据。它拒绝链接路径、未归工具所有的输出目录、损坏/混入文件的网页发布包；生成失败时保留旧上传包。若使用其他本地发布目录，可传 `--site <目录>`；`--out <目录>` 改变上传包输出位置。

## 以后开通 OSS 或 COS

1. 选择实际面向用户的地域和对象存储桶。将 `payload/` 内的内容原样上传，不增加额外的 `payload/` 目录层。若统一放到 `asound/` 前缀，则下载根地址也要带 `/asound`。
2. 只给声音对象所在前缀开放匿名读取，上传和删除保持私有。浏览器不应接收 AccessKey、签名查询参数或云账号凭据。CORS 配置本身不授予文件读取权限。
3. 使用存储控制台提供的**外网 HTTPS 对象访问根地址**；不要填写控制台网址、内网 endpoint 或静态网站页面地址。默认存储桶域名可用于这些资源下载，暂不要求再购买下载域名；后续若使用自定义域名/CDN，应按服务商当时的接入要求配置。参考 [OSS Bucket 域名](https://help.aliyun.com/zh/oss/user-guide/access-oss-via-bucket-domain-name)、[COS 默认域名限制](https://cloud.tencent.com/document/product/436/102509)。安装包不在此次范围内，不要据此推断 APK/IPA 也能按相同方式分发。

上传后，对象键必须保持如下结构：

```text
voice-models/<固定模型版本>/<仓库名>/resolve/main/<原模型文件路径>
assets/<文件SHA-256>/kokoro/...
assets/<文件SHA-256>/audio/voices/<音色>.wav
kokoro/...许可证和来源说明...
LICENSES.md
voice-models.json
```

具体键名以 `manifest.json` 的 `files[].url` 为准，不手工替换版本或摘要。运行文件更新会产生新的摘要路径；不要覆盖旧版本对象，旧网页可能仍在使用它们。

构建时仅将这 5 个运行文件中的 JS/MJS/JSON 文本统一为 LF 换行，因此 Windows 本地准备的摘要路径与同一源码在 Linux CI 的结果一致。WASM、试听音频和模型权重保持原始字节；无镜像地址时也执行同样的文本规范化。

## CORS 和对象响应头

在存储桶的 CORS 设置中配置：

| 项目 | 建议值 |
|---|---|
| Origin | `https://soundoa.cn`；如另有实际网页域名，逐项加入 |
| Allowed Methods | `GET`, `HEAD`；预检 OPTIONS 由存储服务处理 |
| Allowed Headers | `Range` |
| Expose Headers | `Content-Range`, `ETag`, `Accept-Ranges`, `Content-Length`, `Content-Type` |
| Max Age | `600` 秒 |

这是无凭据公开下载，不启用跨站凭据。多个来源并用或接入 CDN 时需正确保留 CORS 头及 `Vary: Origin`，避免缓存混用。配置入口参考 [OSS CORS](https://help.aliyun.com/zh/oss/user-guide/configure-cross-origin-resource-sharing/)、[COS CORS](https://cloud.tencent.com/document/product/436/11488)。

按清单设置对象元数据：`.wasm` 使用 `application/wasm`，`.js/.mjs` 使用 `text/javascript`，`.json` 使用 `application/json`，`.wav` 使用 `audio/wav`，`.onnx/.bin` 使用 `application/octet-stream`。模型版本路径及摘要资源可用 `Cache-Control: public, max-age=31536000, immutable`；普通许可/说明文件用较短缓存，清单提供 `3600` 秒。参考 [OSS Content-Type 配置](https://help.aliyun.com/zh/oss/user-guide/configure-the-content-type-header)。

保持上传字节原样，不手工增加 gzip/br 的 `Content-Encoding`，不启用改写脚本、音频转码或改变对象字节的优化。下载器按固定 SHA-256 核验；错误文件即使能打开，也不能被当成有效模型缓存。

## 验证后再启用地址

先检查一个较大的 `.onnx` 对象：完整 GET 的 SHA-256 必须与清单一致；HEAD 返回完整大小；`Range: bytes=0-1023` 应返回 `206`、1024 字节和 `Content-Range: bytes 0-1023/<完整大小>`。还要从网页来源验证 JavaScript 能读取这些响应头，单纯在地址栏打开文件不能证明 CORS 正确。参考 [OSS GetObject/Range](https://help.aliyun.com/zh/oss/developer-reference/getobject)、[COS GetObject](https://www.tencentcloud.com/document/product/436/7753)。若不暴露 Content-Range，现有下载器会退回完整下载，无法正常续传分段。

再验证 `.mjs/.wasm/.wav` 的 MIME、CORS、完整 SHA-256，以及更新/取消下载、镜像不可用时的本站兜底。用真实国内手机网络比较耗时后，才能判断是否提速。

以下 `example.com` **只是占位示例，不能直接启用**。用验证成功的真实根地址构建：

```powershell
python tools/prepare_soundoa_site.py --with-web-voice --download-base-url https://downloads.example.com/asound
python tools/prepare_download_mirror.py
```

也可直接使用 `tools/build_web.py` 的同名参数。`--download-base-url` 最多重复 3 次；地址须无凭据、查询参数或片段，末尾斜线会移除。只有本机隔离测试允许 localhost、127.0.0.1 或 ::1 的 HTTP 地址，生产使用 HTTPS。

本分支的 GitHub Pages 工作流新增可选仓库变量 `ASOUND_DOWNLOAD_BASE_URL`（默认空）。以后先上传 payload 并通过公开读取、CORS 和校验测试，再审核合并这份接入代码、设置真实根地址并发布，才会启用一个镜像；需要多个镜像时使用上述重复 CLI 参数构建。当前没有替你设置这个变量、合并或触发发布。只设置变量而未发布此分支代码不会生效。

新下载按配置顺序尝试镜像，本站资源保留作兜底；已有断点会优先续传记录中的原来源。`voiceSource`、模型版本和缓存键保持不变，已经安装的相同语音权重不因更换地址被强制重下载。网页和声音文件的版本校验仍生效。没有传下载地址时，构建不新增 `downloadBases` 或资源 `mirrors`，默认发布行为保持原状。
