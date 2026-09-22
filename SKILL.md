---
name: cumob-media-generation4codex
description: Generate or edit images and generate videos with the configured CUMOB provider. Use for image generation, image editing, text-to-video, and video generation from image/video/audio references.
---

# CUMOB Media Generation

Use the bundled Node.js scripts. They read the active provider, base URL, models, and API key from Codex configuration. Never print or pass the API key on the command line.

## Image

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "Describe the image" \
  --out outputs/image.png
```

Add repeatable `--image <path>` and `--image-url <url>` references in any combination. URL references are sent unchanged in the upstream `images` array and are never downloaded locally. Local references larger than 4 MB are compressed before upload without changing the originals. `--mask` requires local images and cannot be combined with URL references. Common options are `--size`, `--quality`, `--format`, `--background`, and `--input-fidelity`. Exact `WIDTHxHEIGHT` output sizes are normalized by the script after download when a local image tool is available.

## Video

```bash
node <skill-dir>/scripts/generate-video.mjs \
  --prompt "Describe the video" \
  --duration 10 \
  --aspect-ratio 16:9 \
  --out outputs/video.mp4
```

References are repeatable:

- `--image` / `--image-url`
- `--video` / `--video-url`
- `--audio` / `--audio-url`

Model limits come from `video-models.json` and are enforced by the script.

For MiniMax H3 structured prompts, follow the official Skill at `vendor-skills/minimax/MiniMax-H3-main/skills/h3-prompt-writing/SKILL.md`. Read only its `references/base-en.txt` for T2VA/I2VA/FL2VA/L2VA or `references/ref-en.txt` for Ref2VA. Do not modify files under that official Skill path.

## Fast Path

When the user's request is complete:

- Read this Skill once. Do not search it again, read README/script source, or load another media-generation Skill.
- Use an already complete user prompt directly. Remove only non-visual interaction text when necessary; never add creative details or produce a longer rewrite.
- Do not run `mkdir`; the scripts create output directories themselves.
- Never download or preview URL references. Pass them with `--image-url`, `--video-url`, or `--audio-url`.
- Do not create a prompt file, run `--dry-run`, inspect files, preview results, or manually check/resize dimensions.
- Run exactly one generation command and wait for it. Do not create a duplicate task while it is queued or running.
- After the script prints `Wrote <path>`, immediately report the absolute output path.
- Only inspect or post-process when the user explicitly requests verification.

## Failure Policy

- A failed upstream task ends the current attempt. Immediately report the exact `failure_reason` and do not submit another generation request.
- Never remove a requested reference, change the prompt/model/size, switch to another Skill or provider, or fall back to text-only generation without explicit user approval.
- Never probe, download, or replace a failed URL reference on your own. For `reference_image_download_failed`, ask the user for an accessible URL or a local file.
- Retrying is allowed only for transient status-query errors while keeping the same task ID. It must never create a second task.

Image tasks poll first after 30 seconds and then every 15 seconds. Video tasks remain at 30-second intervals. Transient status errors retry the same task with a maximum 10-second error backoff. The scripts save `<output>.task.json`; after interruption, resume with `--resume <id-or-task-file>`.
