# CUMOB Media Generation Skill

A minimal Codex Skill for image and video generation.

## Features

- Image generation and editing
- Video generation
- Mixed local and URL image references; URLs are forwarded upstream without local downloads
- Local and URL video/audio references
- Automatic compression of reference images larger than 4 MB to a maximum 1536 px edge
- Image polling after 30 seconds and every 15 seconds thereafter; video polling remains every 30 seconds
- Transient-error backoff capped at 10 seconds
- Automatic final image normalization for exact `WIDTHxHEIGHT` sizes
- Interrupted-task recovery through `<output>.task.json`
- Unmodified vendored MiniMax H3 prompt-writing Skill
- Supports `minimax-h3-fhd`: same parameters, durations, aspect ratios, and reference limits as `minimax-h3`, with fixed 1080p output
- Immediate upstream `failure_reason` reporting with no automatic reference removal or resubmission

## Usage

```bash
node scripts/generate-image.mjs --prompt "A cat" --out outputs/cat.png
```

```bash
node scripts/generate-video.mjs \
  --prompt "A cat running through grass" \
  --duration 10 \
  --aspect-ratio 16:9 \
  --out outputs/cat.mp4
```

### Choosing a model

Use `--image-model` for images and `--video-model` for videos:

```bash
node scripts/generate-image.mjs \
  --prompt "A cat" \
  --image-model gemini-3-pro-image-preview \
  --out outputs/cat.png
```

```bash
node scripts/generate-video.mjs \
  --prompt "A cat running through grass" \
  --video-model minimax-h3-fhd \
  --duration 10 \
  --aspect-ratio 16:9 \
  --out outputs/cat.mp4
```

CUMOB exposes multiple image models (for example `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`, `gpt-image-2.5`). When prompting Codex, simply say "use the gemini-3.1-flash-image-preview model to generate ..." and the agent will pass the matching `--image-model` flag.

Model resolution precedence: command-line `--image-model` / `--video-model` > `image_model` / `video_model` in the active Codex provider config > `OPENAI_IMAGE_MODEL` / `OPENAI_VIDEO_MODEL` environment variables > built-in defaults (`gpt-image-2.5` for images, `minimax-h3` for videos). To pin a model long-term, set `image_model` or `video_model` in the active provider config.

Video model capabilities (durations, aspect ratios, resolutions, reference limits) are declared in `video-models.json`; the script validates and clamps to that registry, and rejects unsupported values with an explicit error.

### Common options

Image:

- `--prompt` / `--prompt-file`: prompt text or file
- `--image <path>` / `--image-url <url>`: repeatable references; local and URL can be mixed
- `--mask <path>`: inpainting mask, local file only
- `--size <WxH>`: e.g. `1024x1024`, `1080x1440`
- `--quality`: `low` / `medium` / `high` / `auto`
- `--format`: `png` / `webp` / `jpeg`
- `--background`: `transparent` / `opaque` / `auto`
- `--input-fidelity`: `high` / `low`; **not sent by default**, only included in the request when explicitly set, because some models do not support it
- `--resume <id or task file>`: resume an interrupted task

Video:

- `--prompt` / `--prompt-file`
- `--duration <seconds>`, `--aspect-ratio <ratio>`, `--resolution <value>`
- `--image/--image-url`, `--video/--video-url`, `--audio/--audio-url`: repeatable references; limits come from `video-models.json`
- `--generate-audio <true|false>`
- `--resume <id or task file>`

Runtime options (shared):

- `--out <path>`
- `--task-file <path>`
- `--poll-interval <seconds>`
- `--timeout <seconds>` (default 1800)
- `--dry-run`: print the request without submitting
- `--json`, `--no-progress`

Local files and URLs can be mixed as image references. URLs are passed unchanged in the upstream `images` field:

```bash
node scripts/generate-image.mjs \
  --prompt "Use both references" \
  --image reference.png \
  --image-url https://example.com/reference.png \
  --size 1080x1440 \
  --out outputs/image.png
```

Video reference options may be repeated:

```bash
node scripts/generate-video.mjs \
  --prompt "Animate the reference image" \
  --image reference.png \
  --out outputs/video.mp4
```

The scripts read `base_url`, `image_model`, `video_model`, and `OPENAI_API_KEY` from the active Codex provider configuration. Node.js 18+ is the only runtime dependency.

```bash
node scripts/generate-image.mjs --help
node scripts/generate-video.mjs --help
node tests/test-media.mjs
```

## Failure policy

When an upstream task returns `failed`, the script exits immediately with the exact `failure_reason`. The Skill does not probe or download a failed reference URL, remove references, switch models, or submit a second task without explicit user approval.
