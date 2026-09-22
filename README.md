# CUMOB Media Generation Skill

一个只负责图片和视频生成的精简 Codex Skill。

## 功能

- 图片生成与编辑
- 视频生成
- 图片参考支持本地文件与 URL 混合输入；URL 直接传给上游，不下载到本地
- 视频、音频参考支持本地文件与 URL
- 大于 4 MB 的参考图自动缩小至最长边 1536 px 并压缩上传
- 图片任务首次等待 30 秒，之后每 15 秒查询；视频仍为每 30 秒查询
- 网络错误重试最多等待 10 秒
- 指定精确 `宽x高` 时自动校正最终图片尺寸
- 通过 `<输出文件>.task.json` 恢复中断任务
- MiniMax H3 使用仓库内原始官方提示词 Skill，官方目录不做修改
- 支持 `minimax-h3-fhd`：与 `minimax-h3` 参数一致，时长 10-15 秒，支持相同画幅和参考素材数量，固定输出 1080p
- 上游失败时立即返回原始 `failure_reason`，不会自动删除参考图或重新生成

## 使用

```bash
node scripts/generate-image.mjs --prompt "一只猫" --out outputs/cat.png
```

```bash
node scripts/generate-video.mjs \
  --prompt "一只猫在草地上奔跑" \
  --duration 10 \
  --aspect-ratio 16:9 \
  --out outputs/cat.mp4
```

### 指定模型

图片模型用 `--image-model`，视频模型用 `--video-model`：

```bash
node scripts/generate-image.mjs \
  --prompt "一只猫" \
  --image-model gemini-3-pro-image-preview \
  --out outputs/cat.png
```

```bash
node scripts/generate-video.mjs \
  --prompt "一只猫在草地上奔跑" \
  --video-model minimax-h3-fhd \
  --duration 10 \
  --aspect-ratio 16:9 \
  --out outputs/cat.mp4
```

CUMOB 支持多个图片模型（例如 `gemini-3-pro-image-preview`、`gemini-3.1-flash-image-preview`、`gpt-image-2.5`）；在 Codex 对话中直接说"用 gemini-3.1-flash-image-preview 模型生成一张……"即可，Codex 会抛出对应的 `--image-model` 参数。

模型的选取优先级为：命令行 `--image-model` / `--video-model` > 当前 Codex provider 配置里的 `image_model` / `video_model` > 环境变量 `OPENAI_IMAGE_MODEL` / `OPENAI_VIDEO_MODEL` > 内置默认值（图片 `gpt-image-2.5`，视频 `minimax-h3`）。如需长期固定模型，把 `image_model` 或 `video_model` 写到当前 provider 的 Codex 配置中即可，不必每次都加命令行参数。

视频模型的画幅、时长、分辨率与参考素材上限由仓库根目录的 `video-models.json` 决定，脚本会自动校验并夹紧到合法范围；不支持的取值会直接报错并退出。

### 常用参数

图片：

- `--prompt` / `--prompt-file`：提示词，或从文件读取
- `--image <path>` / `--image-url <url>`：参考图，可重复使用，本地与 URL 可混用
- `--mask <path>`：局部重绘蒙版，仅支持本地图
- `--size <宽x高>`：如 `1024x1024`、`1080x1440`
- `--quality`：`low` / `medium` / `high` / `auto`
- `--format`：`png` / `webp` / `jpeg`
- `--background`：`transparent` / `opaque` / `auto`
- `--input-fidelity`：`high` / `low`；**默认不发送该参数**，部分模型不支持，只有用户显式传入时才会被加入请求
- `--resume <id 或 task 文件>`：恢复中断的任务

视频：

- `--prompt` / `--prompt-file`
- `--duration <秒>`、`--aspect-ratio <比例>`、`--resolution <分辨率>`
- `--image/--image-url`、`--video/--video-url`、`--audio/--audio-url`：参考素材，可重复使用；上限见 `video-models.json`
- `--generate-audio <true|false>`：是否生成配音
- `--resume <id 或 task 文件>`

运行行为类参数（图片/视频通用）：

- `--out <path>`：输出文件
- `--task-file <path>`：自定义任务状态文件位置
- `--poll-interval <秒>`：覆盖默认轮询节奏
- `--timeout <秒>`：默认 1800
- `--dry-run`：只打印将要发送的请求，不提交
- `--json`、`--no-progress`

图片可以混合使用本地和 URL 参考图。URL 会原样作为 `images` 字段发送给上游：

```bash
node scripts/generate-image.mjs \
  --prompt "综合参考两张图" \
  --image reference.png \
  --image-url https://example.com/reference.png \
  --size 1080x1440 \
  --out outputs/image.png
```

视频参考输入可以重复传入：

```bash
node scripts/generate-video.mjs \
  --prompt "根据参考图生成视频" \
  --image reference.png \
  --out outputs/video.mp4
```

脚本默认读取 Codex 当前 provider 的 `base_url`、`image_model`、`video_model` 和 `auth.json` 中的 `OPENAI_API_KEY`。运行环境只需要 Node.js 18+，无需安装 npm 依赖。

查看全部参数：

```bash
node scripts/generate-image.mjs --help
node scripts/generate-video.mjs --help
```

运行测试：

```bash
node tests/test-media.mjs
```

## 失败策略

上游任务一旦返回 `failed`，脚本立即退出并显示具体 `failure_reason`。Skill 不会自动下载或探测失败的参考图 URL，不会删除参考图、切换模型或提交第二个任务。只有用户明确同意后才能改变生成方案。
