# ASound 国内网页测试与部署

这一版先准备本地测试和静态部署文件。没有购买域名、开通云服务或发布公网网站；也没有从中国大陆网络或真实手机验证模型响应速度。模型仍在用户设备运行，没有新增云端对话接口。

## 两份独立的发布内容

- **网页**：由 `tools/build_web.py` 生成，包含页面、运行时和更新清单，不包含模型权重。
- **模型**：由 `tools/prepare_model_host.py` 生成上传清单；只有提供 `--source-dir` 并且所选文件全部校验通过，才会得到完整的模型文件目录。

本次轻量测试选择 `llm-0.8b-f16,llm-0.8b-f32,llm-cpu,asr-tiny,voice`。服务器要保存两种 GPU 变体和 CPU 回退包，合计约 1.60 GB；单个用户只下载适合自己的一个语言模型，加语音识别与语音合成，约 590 MB（GPU）或 696 MB（CPU），网页资源另计。下载大小不等于运行时内存占用。

## 现在：先生成清单和本地测试包

在仓库根目录运行：

```powershell
.\.venv\Scripts\python.exe tools\build_china_pilot.py
```

这会生成 `dist/web-test/`、`dist/model-host-plan/` 和 `dist/ASound-china-pilot-0.2.1.zip`。
ZIP 包含完整网页、模型上传清单和这份说明，不包含模型权重。拿到实际模型域名后，可在这条命令后
增加 `--model-base-url https://实际模型域名/版本路径` 重新打包。

也可以分步执行并启动本机预览：

```powershell
.\.venv\Scripts\python.exe tools\prepare_model_host.py --out dist\model-host-plan
.\.venv\Scripts\python.exe tools\build_web.py --out dist\web-test --packs llm-0.8b-f16,llm-0.8b-f32,llm-cpu,asr-tiny,voice
.\.venv\Scripts\python.exe -m http.server 8783 --bind 127.0.0.1 --directory dist\web-test
```

打开 `http://127.0.0.1:8783/`。没有传 `--model-base-url` 时，测试包继续使用现有 Hugging Face / 镜像源；生成清单本身不会触发模型下载。普通手机测试不应把电脑上的 `127.0.0.1` 当成手机地址，手机访问还需要受信任的 HTTPS 站点。

`dist/model-host-plan/model-manifest.json` 列出每个文件的公开路径、桌面本地路径、大小、已有 SHA-256、原始下载地址和镜像地址。此时 `readyForUpload` 是 `false`，只有清单，没有模型权重。未获来源校验值的小文件，其 `sha256` 为 `null`。

若已有桌面版下载的模型，可用下面的命令生成实际上传目录：

```powershell
.\.venv\Scripts\python.exe tools\prepare_model_host.py --source-dir app\models --out dist\model-host
```

旧版本也可能把模型放在根目录 `models/`，此时替换 `--source-dir`。工具全程不联网，只读本地文件、按清单检查大小及已有 SHA-256，然后复制。清单没有来源 SHA-256 的文件会记录本地计算值，不能据此声称它已经通过来源认证。

缺失或无效文件会写入清单的 `status`，退出码为 `2`，`readyForUpload` 保持 `false`。已有完整输出不会被不完整输入替换；用一个新 `--out` 保存新的核查结果。工具只会替换自己带标记的输出目录，不接受源目录与输出目录互相嵌套。

## 有域名和云存储后

1. 将校验完整的模型目录上传到自己的 OSS / COS 或其他静态存储。例如公开模型根地址是 `https://models.example.com/asound/v1`，上传后的结构必须是：

   ```text
   asound/v1/
     mlc-ai/Qwen3.5-0.8B-q4f16_1-MLC/resolve/main/...
     mlc-ai/Qwen3.5-0.8B-q4f32_1-MLC/resolve/main/...
     ggml-org/Qwen3.5-0.8B-GGUF/resolve/main/...
     onnx-community/.../resolve/main/...
     libs/Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm
     libs/Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm
   ```

2. 把下面命令中的示例域名替换为实际可访问的模型根地址，再构建：

   ```powershell
   .\.venv\Scripts\python.exe tools\build_web.py --out dist\web-china --model-base-url https://models.example.com/asound/v1 --packs llm-0.8b-f16,llm-0.8b-f32,llm-cpu,asr-tiny,voice
   ```

   构建器只修改产物内的 `packs.json`，不改源文件。产物只保留 `deployment` 下载源，并将其设为默认，模型和 GPU WASM 都指向自己的地址；失败时不会偷偷回退到第三方模型站。`--packs` 隐藏未上传的包，避免提供必然 404 的下载按钮。要启用 2B、4B 或其他语音包，先用同一包列表准备、校验并上传对应文件，再重新构建网页。

3. 将 `dist/web-china/` 全部内容发布到正式 HTTPS 静态站点，保持网站域名稳定。不要直接发布源码 `app/`，也不要直接手改已构建的 `packs.json`，否则更新清单校验会失败。每次改域名、包列表或源代码后，都重新运行构建器。

4. 如果使用中国大陆 CDN 节点，先按服务商要求办理域名 ICP 备案。本次没有完成该步骤或启用 CDN。参见 [腾讯云 CDN 接入说明](https://intl.cloud.tencent.com/document/product/436/18670?lang=en)。

## 模型服务器响应要求

模型地址与网站不同来源时，需要在 CDN 和存储源站配置正确的 CORS；仅设置存储桶而遗漏 CDN 可能仍会失败。至少允许实际网站来源的 `GET`、`HEAD` 和所需预检请求，允许 `Range` 请求头，暴露 `Content-Range`、`Content-Length`、`Accept-Ranges`、`ETag` 响应头。`ETag` 必须对应稳定的文件内容，跨域时必须让浏览器读得到。当前普通下载器逐段核对 ETag，不额外发送 `If-Range`，避免不必要的跨域预检。

Range 下载应返回 `206` 与正确的 `Content-Range: bytes 起点-终点/总大小`；普通完整下载返回 `200`。模型二进制、WASM 和 GGUF 不要动态压缩或改写，避免字节范围与清单大小不一致。浏览器普通模型包的恢复下载和 WebLLM 自己的下载缓存是两条路径；不能把前者的验证结果当成 WebLLM 也通过了相同的恢复测试。

普通模型包会暂存完整分块，合并并验证后才写入模型缓存。合并时可能临时需要接近两份当前文件的空间，
完成后清理分块；请给手机预留足够存储。删除未完成的下载会同时清理它的分块。

- 模型使用包含版本的固定路径，例如 `/asound/v1/`；文件不要原地换成不同内容。改变模型文件或清单后使用新版本路径，再构建并发布网页。
- 模型文件可长缓存。网页 `version.json` 和 `sw.js` 应使用 `Cache-Control: no-cache` 重新验证；其他网页资源也应采用重新验证或短缓存，避免 CDN 在不同文件之间混合版本。
- 发布网页时先上传本次全部资源，最后发布 `version.json` 和 `sw.js`，并刷新对应 CDN 缓存。客户端校验失败时会保留旧版本；部署仍应尽量一次切换完整目录。
- 更新检查、离线网页缓存与模型缓存独立。浏览器清理缓存、换域名或撤销存储后，模型可能需要重新下载。

配置参考：[阿里云 CDN CORS](https://help.aliyun.com/zh/cdn/user-guide/configure-cors)、[Range 回源](https://help.aliyun.com/zh/cdn/user-guide/object-chunking/)。

## 小规模试用验收

上线前用实际大陆网络与目标手机逐项记录结果：首次完整下载时间、切换网络后的恢复、首次模型加载、录音结束到回答开始的等待时间、连续十轮对话的稳定性、完整缓存后的断网启动，以及更新后练习记录是否保留。分别覆盖计划支持的 Android 和 iPhone 浏览器。局域网、模拟手机布局和小文件下载测试都不能替代这些结果。

如果某些手机无法稳定运行本地模型，需要明确设备要求或另行增加云端模式；封装成 APK / IPA 不会自动降低这套浏览器模型的内存或下载要求。
