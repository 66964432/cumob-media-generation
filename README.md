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
