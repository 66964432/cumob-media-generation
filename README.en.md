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
