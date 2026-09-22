#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  appendFile,
  die,
  download,
  errorMessage,
  optimizeImages,
  parseArgs,
  pollTask,
  readPrompt,
  requestJson,
  resolveConfig,
  resumeId,
  taskFile,
  writeTask,
} from "./media-common.mjs";

const HELP = `
Usage: node scripts/generate-video.mjs --prompt "..." [options]

Core:
  --out <path>                  Default: generated.mp4
  --video-model <model>         Default: configured video_model or minimax-h3
  --duration <seconds>
  --aspect-ratio <ratio>
  --resolution <value>
  --image/--image-url <value>   Repeatable image references
  --video/--video-url <value>   Repeatable video references
  --audio/--audio-url <value>   Repeatable audio references
  --generate-audio <true|false>

Input optimization:
  --max-input-dimension <px>    Default: 1536
  --input-jpeg-quality <1-100>  Default: 85
  --input-optimize-threshold-mb <mb>  Default: 4
  --no-input-optimization

Task:
  --resume <id-or-task-file>
  --task-file <path>
  --poll-interval <seconds>     Default: 30
  --timeout <seconds>           Default: 1800
  --dry-run
  --json
  --no-progress
`;

const args = parseArgs(process.argv.slice(2), {
  repeated: ["image", "image-url", "video", "video-url", "audio", "audio-url"],
  flags: ["help", "dry-run", "json", "no-progress", "no-input-optimization"],
  valued: [
    "prompt", "prompt-file", "out", "video-model", "duration", "aspect-ratio", "resolution", "generate-audio",
    "codex-home", "base-url", "api-key-env", "resume", "task-file", "poll-interval", "timeout",
    "max-input-dimension", "input-jpeg-quality", "input-optimize-threshold-mb",
  ],
});

if (args.help) {
  console.log(HELP.trim());
  process.exit(0);
}
if (typeof fetch !== "function") die("Node.js 18+ is required");

const output = args.out || "generated.mp4";
const stateFile = taskFile(args, output);
const existingId = resumeId(args);
const optimized = existingId ? { files: [], details: [], cleanup: () => {} } : optimizeImages(args.image, args, "video-generation");
args.image = optimized.files;

const registry = JSON.parse(fs.readFileSync(new URL("../video-models.json", import.meta.url), "utf8"));
const config = resolveConfig(args, "video");
config.model = registry.model_aliases?.[config.model] || config.model;
const capabilities = registry.models?.[config.model] || { duration: { min: 3, max: 20, default: 10 } };

function normalizedRequest(prompt) {
  const limits = capabilities.duration || { min: 3, max: 20, default: 10 };
  let duration = args.duration === undefined ? limits.default : Math.round(Number(args.duration));
  if (!Number.isFinite(duration)) die("--duration must be a number");
  let aspectRatio = args["aspect-ratio"];
  if (aspectRatio && capabilities.aspect_ratios && !capabilities.aspect_ratios.includes(aspectRatio)) die(`unsupported aspect ratio for ${config.model}: ${aspectRatio}`);
  const resolution = capabilities.fixed_resolution || args.resolution || capabilities.default_resolution;
  if (args.resolution && capabilities.resolutions && !capabilities.resolutions.includes(args.resolution)) die(`unsupported resolution for ${config.model}: ${args.resolution}`);
  const resolutionMax = capabilities.resolution_duration_max?.[resolution];
  duration = Math.min(resolutionMax ?? limits.max, Math.max(limits.min, duration));

  const imageCount = args.image.length + args["image-url"].length;
  const videoCount = args.video.length + args["video-url"].length;
  const audioCount = args.audio.length + args["audio-url"].length;
  if (imageCount > (capabilities.max_images ?? Infinity)) die(`${config.model} accepts at most ${capabilities.max_images} image references`);
  if (videoCount > (capabilities.max_videos ?? Infinity)) die(capabilities.max_videos === 0 ? `${config.model} does not support video references` : `${config.model} accepts at most ${capabilities.max_videos} video references`);
  if (audioCount > (capabilities.max_audios ?? Infinity)) die(`${config.model} accepts at most ${capabilities.max_audios} audio references`);
  if (imageCount + videoCount + audioCount > (capabilities.max_total_references ?? Infinity)) die(`${config.model} accepts at most ${capabilities.max_total_references} total references`);

  const body = { model: config.model, prompt, duration, async: true };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution && !capabilities.fixed_resolution) body.resolution = resolution;
  if (args["image-url"].length) body.images = args["image-url"];
  if (args["video-url"].length) body.videos = args["video-url"];
  if (args["audio-url"].length) body.audios = args["audio-url"];
  if (args["generate-audio"] !== undefined) {
    if (!['true', 'false'].includes(args["generate-audio"])) die("--generate-audio must be true or false");
    body.generate_audio = args["generate-audio"] === "true";
  }
  return { body, resolution, counts: { images: imageCount, videos: videoCount, audios: audioCount } };
}

function videoUrl(task) {
  return task?.video_url || task?.data?.find?.((item) => item?.video_url)?.video_url || null;
}

async function main() {
  try {
    const headers = { Authorization: `Bearer ${config.apiKey}` };
    let task;
    let request;

    if (existingId) {
      task = await pollTask({
        id: existingId,
        args,
        scope: "video-generation",
        statusUrl: `${config.baseUrl}/status`,
        headers,
        output,
        model: config.model,
        completed: (value) => String(value?.status).toLowerCase() === "succeeded" && Boolean(videoUrl(value)),
      });
    } else {
      request = normalizedRequest(await readPrompt(args));
      const localMedia = args.image.length || args.video.length || args.audio.length;
      if (args["dry-run"]) {
        console.log(JSON.stringify({
          endpoint: `${config.baseUrl}/videos`,
          model: config.model,
          request: request.body,
          effective_resolution: request.resolution || null,
          references: request.counts,
          local_files: { images: args.image, videos: args.video, audios: args.audio },
          input_optimization: optimized.details,
          has_api_key: config.hasApiKey,
          task_file: stateFile,
        }, null, 2));
        return;
      }

      let options;
      if (localMedia) {
        const form = new FormData();
        for (const [key, value] of Object.entries(request.body)) {
          if (!["images", "videos", "audios"].includes(key)) form.append(key, String(value));
        }
        args["image-url"].forEach((url) => form.append("images", url));
        args["video-url"].forEach((url) => form.append("videos", url));
        args["audio-url"].forEach((url) => form.append("audios", url));
        args.image.forEach((file) => appendFile(form, "images", file));
        args.video.forEach((file) => appendFile(form, "videos", file));
        args.audio.forEach((file) => appendFile(form, "audios", file));
        options = { method: "POST", headers, body: form };
      } else {
        options = { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(request.body) };
      }

      try {
        task = await requestJson(`${config.baseUrl}/videos`, options);
      } catch (error) {
        die(`video create request failed: ${errorMessage(error.body || error)}`);
      }
      if (!task.id) die("video API returned no task id");
      writeTask(stateFile, { id: task.id, status: task.status, model: config.model, output, updated_at: new Date().toISOString() });
      if (!videoUrl(task)) {
        task = await pollTask({
          id: task.id,
          args,
          scope: "video-generation",
          statusUrl: `${config.baseUrl}/status`,
          headers,
          output,
          model: config.model,
          initial: task,
          completed: (value) => String(value?.status).toLowerCase() === "succeeded" && Boolean(videoUrl(value)),
        });
      }
    }

    const url = videoUrl(task);
    if (!url) die("video task completed without a video URL");
    await download(url, output, config.apiKey);
    const summary = { id: task.id || existingId, model: config.model, output };
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else console.log(`Wrote ${output}`);
  } finally {
    optimized.cleanup();
  }
}

main().catch((error) => die(error.stack || error.message || String(error)));
