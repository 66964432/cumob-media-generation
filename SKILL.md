---
name: cumob-media-generation4codex
description: Use this skill whenever the user asks to generate or edit images (生图/生成图片), or generate videos (生视频/生成视频), through the configured CUMOB/OpenAI-compatible provider. Route image requests to the bundled image script and video requests to the bundled CUMOB Videos API script.
---

# Configured CUMOB Image and Video Generation

Use this skill to create or edit images through the active Codex provider. The bundled scripts select the backend from `[model_providers.<name>].image_api`:

- `image_api = "images"`: call `<base_url>/images/generations` or `<base_url>/images/edits` directly.
- `image_api = "responses"` or unset: call `<base_url>/responses` with the `image_generation` tool.

For CUMOB, configure `base_url = "https://api.cumob.com/v1"`, `image_api = "images"`, and `image_model = "gpt-image-2.5"`.

For CUMOB video generation, use the bundled `scripts/generate-video.mjs` (or its Python fallback). Configure `video_api = "videos"` and `video_model` to the desired default. The script calls `<base_url>/videos` with `async=true` and polls `<base_url>/status/{id}`. Video model capabilities are loaded from `video-models.json`; duration, fixed resolution, supported fields, and reference limits are enforced per model. `minimax-h3` accepts 10-15 seconds, uses fixed 768p, and supports video references. `minimax-h3-2k` accepts 10-15 seconds, uses fixed 1440p, and rejects video references before submission. Fixed resolutions are not sent because CUMOB applies the model default. Image, video, and audio references use the top-level `images`, `videos`, and `audios` fields; `metadata` is reserved for user-defined task context. Local reference media use multipart upload, while URL-only references use JSON.

## Vendor Prompt Skills

Some video models are mapped to an official vendor prompt-writing Skill in
`video-models.json`. The original vendor files are vendored under
`vendor-skills/` and must remain unchanged. The registry records their source,
path, supported modes, and integrity hashes; project-specific orchestration
belongs in this Skill and in the validation scripts.

For a model mapped to an official prompt Skill, follow this order:

1. Resolve the selected model and its effective CUMOB capabilities first,
   including normalized duration, fixed resolution, and reference limits.
2. Use the model running the current Codex task to optimize the user's request
   according to the mapped vendor Skill. For MiniMax H3, read the vendored
   `h3-prompt-writing/SKILL.md` and the relevant `references/base-en.txt` or
   `references/ref-en.txt`.
3. Do not call H3-Context-IR or any other external prompt-enhancement API by
   default. `generate-video.mjs` and `generate-video.py` never make a prompt
   model request; they only validate and submit the final prompt.
4. Choose T2VA, I2VA, FL2VA, L2VA, or Ref2VA from the user's intent. One image
   does not automatically imply I2VA; use Ref2VA when the media is reference
   material rather than an explicit keyframe.
5. Write the optimized prompt to a UTF-8 `.prompt.txt` file and pass it with
   `--prompt-file`. Do not truncate a structured H3 prompt.
6. Run `scripts/validate-video-prompt.mjs` (or its Python fallback), or rely on
   the video script's built-in validation, before submitting the API request.
7. Preserve the vendor's official labels (`<Picture N>`, `<Video N>`,
   `<Audio N>`, `<Subject N>`) in an H3 prompt. Legacy `@图片N`, `@视频N`, and
   `@音频N` remain supported for ordinary prompts, but the two label systems
   must not be mixed in one prompt.

For prompts optimized in this Codex workflow, pass `--prompt-source
codex-current-model`. A direct CLI prompt defaults to `user` provenance.
`--prompt-source minimax-context-ir` only records that a prompt was prepared
elsewhere; it does not call that paid service. Use it only when the user
explicitly supplied or requested an externally prepared prompt. A future
Context-IR adapter, if added, must be explicit, separately authenticated, and
opt-in; it must never be an automatic fallback.

For H3, CUMOB model capabilities take precedence over the vendor's general
prompt guide. Normalize a requested duration to the model's effective range
before writing timestamps. `first_frame` and `last_frame` may be expressed as
prompt semantics, but they are not CUMOB API fields for the current H3 models.

For CUMOB image generation/editing, use `image_api = "images"`. The bundled Images API path sends `async=true` for both JSON generation and multipart edits, then polls `<base_url>/status/{id}` until the task succeeds. It accepts synchronous final responses as a compatibility fallback. `--resume` and `<output>.task.json` can resume an image task without creating a duplicate.

## Runtime And Dependencies

- Preferred runtime: Node.js 18+ with `scripts/generate-image.mjs`.
- Fallback runtime: Python 3 with `scripts/generate-image.py` when Node is unavailable.
- The Node script uses only built-in modules: `fs`, `os`, `path`, and `child_process`, plus built-in `fetch`.
- The Python script uses only the standard library: `urllib`, `json`, `base64`, `pathlib`, and related built-ins.
- Local image input optimization uses macOS `sips` when available, or ImageMagick's `magick` command on other platforms. Neither tool is required; the scripts fall back to the original image when no optimizer is available. Local video/audio files are uploaded as-is; they are not transcoded.
- Does not require `npm install`, `pip install`, the OpenAI SDK, curl, jq, or base64 shell utilities.
- Works on Linux, macOS, and Windows when run as `node <skill-dir>/scripts/generate-image.mjs ...` or `python3 <skill-dir>/scripts/generate-image.py ...`.
- Do not rely on executable bits, shebang behavior, or Bash line continuations for Windows usage.
- The scripts print progress messages to stderr while waiting for the API; stdout remains reserved for the final file summary or `--json` output.

## Source Of Credentials

Use Codex's API configuration by default:

- Read `$CODEX_HOME/config.toml` when `CODEX_HOME` is set.
- Otherwise read `<home>/.codex/config.toml`; this maps to `~/.codex` on Linux/macOS and `%USERPROFILE%\.codex` on Windows.
- Use the top-level `model_provider` and that provider's `[model_providers.<name>]` table.
- Use provider `base_url` as the API URL.
- Use provider `image_api` to select `images` or `responses`; default to `responses` for backward compatibility.
- Use provider `image_model` as the image model unless `--image-model` overrides it.
- Use provider `video_model` as the video model unless `--video-model` overrides it; the video script defaults to `minimax-h3`.
- Use the top-level `model` as the Responses model unless the user explicitly asks for another model.
- Read `OPENAI_API_KEY` from the matching `auth.json`.
- Do not ask the user for an API key when Codex config is available.
- Do not print, log, commit, or summarize credential values.
- Do not read or display `auth.json` yourself during normal use; let the bundled script read it inside the child process.
- Do not pass secret values on the command line. The scripts intentionally reject `--api-key <value>`.

If the Codex config is unavailable, the scripts fall back to `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_VIDEO_MODEL`, and `OPENAI_API_KEY`. Environment variable lookup is case-insensitive so Windows variants such as `openai_api_key` still resolve. Treat this as a fallback, not the normal path.

If the user keeps the key in a different environment variable, pass only the variable name:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "A quick test image" \
  --out outputs/test.png \
  --api-key-env MY_OPENAI_API_KEY
```

PowerShell example for a current-session variable:

These examples use placeholders. Do not paste real API keys into agent chats, logs, or committed files.

```powershell
$env:OPENAI_API_KEY = "<your-api-key>"
node <skill-dir>\scripts\generate-image.mjs --prompt "A quick test image" --out outputs\test.png
```

`cmd.exe` example for a current-session variable:

```bat
set OPENAI_API_KEY=<your-api-key>
node <skill-dir>\scripts\generate-image.mjs --prompt "A quick test image" --out outputs\test.png
```

## Long-Running Behavior

Treat image generation and editing as long-running operations. A normal request can take several minutes, especially for high quality, image edits, multiple inputs, or slow compatible providers.

- Run exactly one generation command for a user request, then wait for that command to finish.
- Do not start a second generation just because the command has not returned quickly, has only printed progress messages, or appears idle.
- If your shell tool exposes a running session, poll or wait on the existing session instead of launching the same command again.
- Rerun only after the command exits with an error, the user explicitly asks for another variation, or you intentionally change the prompt/settings.
- Treat `[image-generation] Still waiting...` messages as healthy progress, not as a failure condition.
- Use `--no-progress` only when stderr must stay silent; otherwise leave progress enabled so long requests are visibly alive.

Image and video generation are long-running. Send exactly one create request with `async=true`, then let the corresponding script poll the returned task id until `succeeded` or `failed`. Never start another create request merely because the status is `queued` or `running`. Normal status checks use a fixed 30-second interval by default (override with `--poll-interval <seconds>`); successful checks do not increase that interval. A server-provided `retry_after`/`retryAfter` value takes precedence, while transient network/408/425/429/5xx errors use independent exponential backoff capped at 60 seconds. If the process is interrupted or reaches its local timeout, keep the task file and use `--resume <id>` to continue polling the existing task.

The image and video scripts persist the task id and latest status in `<output>.task.json` (or the path supplied with `--task-file`) immediately after creation. Treat `TypeError: fetch failed`, connection resets, timeouts, and transient 4xx/5xx status responses during polling as recoverable; the scripts retry them with backoff while keeping the same task id. A create request whose response cannot be confirmed must not be blindly retried, because CUMOB may already have accepted it.

## Automatic Input Optimization

Input optimization is a fixed part of the default workflow. Before an edit request, the scripts inspect every `--image` file and locally prepare a temporary upload copy when the file is larger than 4 MB:

- Resize the longest side to at most 1536 pixels.
- Convert ordinary photographic inputs to JPEG at quality 85.
- Preserve PNG for images with an alpha channel.
- Never modify the original file.
- Never optimize the `--mask` file.
- Delete all temporary copies when the command exits.
- Use the original file without failing when `sips` or ImageMagick is unavailable.

The progress output reports the original and optimized sizes. For example:

```text
[image-generation] Optimized input 1/2 locally with sips: 10.1MB -> 603KB.
```

Use `--no-input-optimization` only when exact source bytes are required or local preprocessing causes a compatibility issue. Override the defaults with `--max-input-dimension`, `--input-jpeg-quality`, or `--input-optimize-threshold-mb`.

## Default Workflow

1. Determine whether the user wants an image or a video. Use `generate-image.mjs` for image/edit requests and `generate-video.mjs` for video requests.
2. Clarify only missing requirements that materially affect the requested media, such as subject, duration, aspect ratio, reference inputs, or output filename.
3. Prefer saving generated files under a local output directory such as `outputs/` unless the user named a path.
4. Run one bundled script once and wait for it to complete. The image script creates one async CUMOB task, polls it, and saves URL/Base64 results; the video script creates one async task, polls it, and downloads the MP4. Prefer Node when available:

   ```bash
   node <skill-dir>/scripts/generate-image.mjs \
     --prompt "A precise image prompt" \
     --out outputs/result.png \
     --size 1024x1024 \
     --quality high
   ```

   If Node is unavailable, use the Python fallback with the same options:

   ```bash
   python3 <skill-dir>/scripts/generate-image.py \
     --prompt "A precise image prompt" \
     --out outputs/result.png \
     --size 1024x1024 \
     --quality high
   ```

   On Windows, if `python3` is not available but the Python launcher is installed, use `py -3`:

   ```powershell
   py -3 <skill-dir>\scripts\generate-image.py `
     --prompt "A precise image prompt" `
     --out outputs\result.png `
     --size 1024x1024 `
     --quality high
   ```

5. If network access is restricted, request the narrowest command approval needed to run the script. Explain that the command calls the user's configured CUMOB/OpenAI-compatible API endpoint.
6. Report the created media path and key generation settings. Do not include raw response JSON unless debugging is needed.

For Windows PowerShell, use backticks for line continuation or put the command on one line:

```powershell
node <skill-dir>\scripts\generate-image.mjs `
  --prompt "A precise image prompt" `
  --out outputs\result.png `
  --size 1024x1024 `
  --quality high
```

For `cmd.exe`, prefer one line:

```bat
node <skill-dir>\scripts\generate-image.mjs --prompt "A precise image prompt" --out outputs\result.png --size 1024x1024 --quality high
```

If Node is not installed on Windows but Python is available:

```bat
py -3 <skill-dir>\scripts\generate-image.py --prompt "A precise image prompt" --out outputs\result.png --size 1024x1024 --quality high
```

If neither Node nor Python is available, stop and tell the user one local runtime is required. Do not try to install one unless the user explicitly approves it.

## Common Commands

Generate a video with CUMOB `minimax-h3`:

```bash
node <skill-dir>/scripts/generate-video.mjs \
  --prompt "一只猫在阳光下追逐@图片1中的毛线球" \
  --image reference.png \
  --duration 10 \
  --aspect-ratio 16:9 \
  --out outputs/cat.mp4
```

Reference videos and audios can be supplied as local files (`--video`, `--audio`) or public URLs (`--video-url`, `--audio-url`). They are referenced in the prompt with `@视频1` and `@音频1`:

```bash
node <skill-dir>/scripts/generate-video.mjs \
  --prompt "按照@视频1的动作节奏并使用@音频1的声音氛围" \
  --video-url https://example.com/motion.mp4 \
  --audio-url https://example.com/audio.mp3 \
  --out outputs/remix.mp4
```

For both MiniMax H3 models, `duration` must be an integer from 10 through 15 (default 10), images must not exceed 9, audios must not exceed 3, and total image/video/audio references must not exceed 12. `minimax-h3` additionally accepts up to 3 videos; `minimax-h3-2k` accepts no video references. Legacy model identifiers `minimax-h3-ref`, `minimax-h3-2k-ref`, and `agnes-video-v2.0-ref` are compatibility aliases for their canonical identifiers. Do not send `negative_prompt`, `hd`, `first_frame`, or `last_frame` to either model.

Generate a new image:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "A product photo of a matte black ceramic mug on a walnut desk, soft window light" \
  --out outputs/mug.png \
  --size 1024x1024 \
  --quality high
```

Same command with Python fallback:

```bash
python3 <skill-dir>/scripts/generate-image.py \
  --prompt "A product photo of a matte black ceramic mug on a walnut desk, soft window light" \
  --out outputs/mug.png \
  --size 1024x1024 \
  --quality high
```

Generate with transparent background:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "A clean app icon of a folded paper crane, centered, no text" \
  --out outputs/icon.png \
  --background transparent \
  --format png
```

Edit or restyle from an input image:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "Restyle this image as a polished editorial illustration while preserving the composition" \
  --image reference.png \
  --action edit \
  --input-fidelity high \
  --out outputs/restyled.png
```

Use a mask for inpainting when the API supports it:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "Replace the masked area with a glass vase of yellow flowers" \
  --image room.png \
  --mask mask.png \
  --action edit \
  --out outputs/inpainted.png
```

Preview the resolved config and request body without calling the API:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "A quick test image" \
  --out outputs/test.png \
   --dry-run
```

For a one-off backend override:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --image-api images \
  --image-model gpt-image-2.5 \
  --prompt "A quick test image" \
  --out outputs/test.png
```

## Supported Options

The scripts map common image generation options to either the Images API or Responses image tool:

- `--action generate|edit|auto`
- `--image <path>` one or more input images for guided generation or editing
- `--mask <path>` optional inpainting mask
- `--image-model <model>` image model for the tool, such as `gpt-image-1`
- `--size <size>` such as `1024x1024`, `1024x1536`, `1536x1024`, or API-supported custom sizes
- `--quality low|medium|high|auto`
- `--format png|webp|jpeg`
- `--background transparent|opaque|auto`
- `--input-fidelity high|low`
- `--moderation auto|low`
- `--output-compression <0-100>`
- `--max-input-dimension <pixels>` local input resize limit; defaults to `1536`
- `--input-jpeg-quality <1-100>` local JPEG quality; defaults to `85`
- `--input-optimize-threshold-mb <number>` optimize inputs larger than this; defaults to `4`
- `--no-input-optimization` uploads original input images without local preprocessing
- `--response-model <model>` Responses model; defaults to Codex's configured model
- `--image-api responses|images` overrides the provider's `image_api`
- `--api-key-env <name>` API key environment variable name when Codex auth is unavailable; defaults to `OPENAI_API_KEY`
- `--poll-interval <seconds>` status poll interval; defaults to `30` seconds. Successful checks keep this interval; transient errors use separate exponential backoff.
- `--no-progress` disables progress messages on stderr while waiting for the API

Images API mode accepts either `data[].b64_json` or `data[].url` responses. Responses mode reads `output[].type == image_generation_call`.

When using the CUMOB Images API, requests include `async=true` by default. Use `--resume <id>` or `--resume <task-file>` after an interrupted image task; no second create request is sent.

Video options are exposed by `scripts/generate-video.mjs`: `--video-model`, `--prompt`, `--prompt-file`, `--prompt-mode`, `--prompt-source`, `--duration`, `--aspect-ratio`, `--resolution`, `--image`, `--image-url`, `--video`, `--video-url`, `--audio`, `--audio-url`, `--generate-audio`, `--webhook`, `--metadata-json`, `--poll-interval`, `--timeout`, `--resume`, and `--task-file`. A requested resolution is validated against the selected model; fixed-resolution Minimax models omit it from the API request and report the effective resolution in `--dry-run` and result summaries. The dry-run output and task/summary metadata include prompt validation, selected vendor Skill, and prompt provenance.

## Quality Guidance

For better results, write prompts with concrete visual constraints:

- Subject, setting, medium, lighting, composition, aspect ratio, and any text that must appear.
- Negative constraints when helpful, such as "no watermark" or "no extra text".
- For edits, describe what must stay unchanged as clearly as what should change.
- For UI or product assets, specify background, transparency, icon padding, and output format.

## Failure Handling

If no image result is returned:

- Check whether the response contains a refusal, tool error, or policy message.
- Re-run with `--dry-run` to confirm config and request shape.
- Do not retry while the original generation command is still running. Wait for a success or failure exit first.
- Run `--dry-run` and verify `image_api`, `endpoint`, and `image_model`.
- For `image_api = "images"`, verify the provider supports `/images/generations` and `/images/edits`.
- For `image_api = "responses"`, verify the provider supports the Responses API `image_generation` tool.
- Do not expose the API key while debugging. Redact request headers and auth fields.
- Do not use `cat`, `type`, `Get-Content`, or similar commands on `auth.json` for debugging. Use the script's `--dry-run`, which only reports `has_api_key` and `api_key_source`.
- For video failures, inspect the returned task `id`, `status`, `error`, and `failure_reason`; use `--resume <id>` instead of creating a duplicate task.
- If polling stops because the overall timeout is reached, keep the task file and resume the same task later; do not send a new POST unless you have confirmed that the old task was never created.
