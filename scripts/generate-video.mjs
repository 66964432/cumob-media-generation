#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadVideoRegistry, validateVideoPrompt } from "./video-prompt-validation.mjs";

const DEFAULT_POLL_INTERVAL_SECONDS = 30;

const HELP = `
Usage:
  node scripts/generate-video.mjs --prompt "..." --out outputs/video.mp4 [options]

Required (unless --resume is used):
  --prompt <text>             Video prompt. Use --prompt-file for structured H3 prompts.
  --prompt-file <path>        Read the final prompt from a UTF-8 text file.

Output:
  --out <path>                Output MP4 path. Default: generated.mp4

Codex/CUMOB config:
  --codex-home <path>         Defaults to $CODEX_HOME or <home>/.codex
  --base-url <url>            Provider base URL, normally https://api.cumob.com/v1
  --video-create-url <url>    Override the create endpoint.
  --video-status-url <url>    Override the status endpoint base (without /{id}).
  --video-model <model>       Defaults to provider video_model or minimax-h3-ref.
  --api-key-env <name>        Environment fallback for the API key.
  --prompt-mode <mode>        T2VA, I2VA, FL2VA, L2VA, or Ref2VA.
  --prompt-source <source>    Prompt provenance: user, codex-current-model, or minimax-context-ir.

Video options:
  --duration <seconds>        Integer seconds (normalized to the selected model's capabilities).
  --aspect-ratio <ratio>      Requested output aspect ratio.
  --resolution <value>        Requested resolution. Fixed-resolution models omit it from the request.
  --image <path>              Local reference image; can be repeated (max 9).
  --image-url <url>           Public reference image URL; can be repeated (max 9).
  --video <path>              Local reference video; can be repeated (max 3).
  --audio <path>              Local reference audio; can be repeated (max 3).
  --video-url <url>           Public reference video URL; can be repeated (max 3).
  --audio-url <url>           Public reference audio URL; can be repeated (max 3).
  --generate-audio <boolean>  Request generated audio when supported (true or false).
  --webhook <url>             Optional task completion webhook.
  --metadata-json <json>      Optional JSON object containing task metadata.
  --resume <id>               Resume polling an existing CUMOB task; does not create a new task.
  --task-file <path>          Persist task id/status for recovery. Default: <out>.task.json.

Other:
  --poll-interval <seconds>   Poll interval. Default: ${DEFAULT_POLL_INTERVAL_SECONDS}.
  --timeout <seconds>         Overall timeout. Default: 1800.
  --dry-run                   Print redacted config/request without calling the API.
  --json                      Print a machine-readable summary.
  --max-input-dimension <px> Maximum optimized image dimension. Default: 1536.
  --input-jpeg-quality <1-100> JPEG quality for optimized images. Default: 85.
  --input-optimize-threshold-mb <number> Optimize images above this size. Default: 4.
  --no-input-optimization    Upload original reference images.
  --no-progress               Disable progress messages on stderr.
  --help
`;

const RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "3:2", "2:3"]);

function die(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function progress(args, message) {
  if (!args["no-progress"]) console.error(`[video-generation] ${message}`);
}

function parseArgs(argv) {
  const args = { image: [], "image-url": [], video: [], audio: [], "video-url": [], "audio-url": [], imageInputs: [], videoInputs: [], audioInputs: [] };
  const flags = new Set(["help", "dry-run", "json", "no-progress", "no-input-optimization"]);
  const repeated = new Set(["image", "image-url", "video", "audio", "video-url", "audio-url"]);
  const valued = new Set([
    "prompt", "prompt-file", "out", "codex-home", "base-url", "video-create-url", "video-status-url",
    "video-model", "api-key-env", "duration", "aspect-ratio", "resolution", "generate-audio", "webhook",
    "metadata-json", "prompt-mode", "prompt-source", "resume", "task-file", "poll-interval", "timeout", "max-input-dimension",
    "input-jpeg-quality", "input-optimize-threshold-mb",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) die(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "api-key") die("--api-key is not supported. Use Codex auth.json or --api-key-env.");
    if (flags.has(key)) {
      args[key] = true;
      continue;
    }
    if (!repeated.has(key) && !valued.has(key)) die(`unsupported option: --${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) die(`missing value for --${key}`);
    i += 1;
    if (repeated.has(key)) {
      args[key].push(value);
      if (key === "image" || key === "image-url") args.imageInputs.push({ key, value });
      if (key === "video" || key === "video-url") args.videoInputs.push({ key, value });
      if (key === "audio" || key === "audio-url") args.audioInputs.push({ key, value });
    } else {
      args[key] = value;
    }
  }
  return args;
}

function transientNetworkError(error) {
  if (error instanceof HttpError) return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  return error?.name === "TypeError" || error?.name === "AbortError" || /fetch failed|network|timeout|reset|socket|connect/i.test(error?.message || "");
}

function taskStatePath(args, outputPath) {
  return path.resolve(args["task-file"] || `${outputPath}.task.json`);
}

function writeTaskState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  let existing = {};
  if (fs.existsSync(filePath)) {
    try { existing = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { existing = {}; }
  }
  fs.writeFileSync(temp, `${JSON.stringify({ ...existing, ...state }, null, 2)}\n`);
  fs.renameSync(temp, filePath);
}

function readTaskState(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) { die(`failed to parse task file ${filePath}: ${error.message}`); }
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseTomlLite(text) {
  const root = {};
  const sections = {};
  let current = root;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].replaceAll('"', "");
      sections[name] ||= {};
      current = sections[name];
      continue;
    }
    const pair = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (pair) current[pair[1]] = parseTomlValue(pair[2]);
  }
  return { root, sections };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    die(`failed to parse ${filePath}: ${error.message}`);
  }
}

function envValue(name) {
  if (process.env[name] !== undefined) return process.env[name];
  const lower = name.toLowerCase();
  return Object.entries(process.env).find(([key]) => key.toLowerCase() === lower)?.[1];
}

function validateEnvName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) die("--api-key-env must be an environment variable name.");
}

function resolveConfig(args) {
  const codexHome = path.resolve(args["codex-home"] || envValue("CODEX_HOME") || path.join(os.homedir(), ".codex"));
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const config = fs.existsSync(configPath) ? parseTomlLite(fs.readFileSync(configPath, "utf8")) : { root: {}, sections: {} };
  const providerName = config.root.model_provider || "OpenAI";
  const provider = config.sections[`model_providers.${providerName}`] || {};
  const keyEnv = args["api-key-env"] || "OPENAI_API_KEY";
  validateEnvName(keyEnv);
  const baseUrl = (args["base-url"] || provider.base_url || envValue("OPENAI_BASE_URL") || "https://api.cumob.com/v1").replace(/\/+$/, "");
  const createUrl = (args["video-create-url"] || provider.video_create_url || `${baseUrl}/videos`).replace(/\/+$/, "");
  const statusUrl = (args["video-status-url"] || provider.video_status_url || `${baseUrl}/status`).replace(/\/+$/, "");
  const model = args["video-model"] || provider.video_model || envValue("OPENAI_VIDEO_MODEL") || "minimax-h3-ref";
  const auth = readJsonIfExists(authPath);
  const apiKey = auth.OPENAI_API_KEY || envValue(keyEnv);
  if (!apiKey && !args["dry-run"]) die(`no API key found in ${authPath} or environment variable ${keyEnv}.`);
  return {
    codexHome, configPath, authPath, providerName, baseUrl, createUrl, statusUrl, model,
    apiKey, hasApiKey: Boolean(apiKey), apiKeySource: auth.OPENAI_API_KEY ? "codex-auth" : apiKey ? `env:${keyEnv}` : "none",
  };
}

const FALLBACK_VIDEO_CAPABILITIES = {
  duration: { min: 4, max: 20, default: 10 },
  aspect_ratios: [...RATIOS],
};

function loadVideoCapabilities(model) {
  const file = path.resolve(path.dirname(process.argv[1]), "../video-models.json");
  try {
    const registry = JSON.parse(fs.readFileSync(file, "utf8"));
    return registry.models?.[model] || FALLBACK_VIDEO_CAPABILITIES;
  } catch {
    return FALLBACK_VIDEO_CAPABILITIES;
  }
}

function normalizeVideoParameters(args, config) {
  const capabilities = loadVideoCapabilities(config.model);
  const requestedDuration = args.duration === undefined ? null : Number(args.duration);
  let duration = requestedDuration === null ? Number(capabilities.duration?.default ?? 10) : requestedDuration;
  const adjustments = [];
  const minDuration = Number(capabilities.duration?.min ?? 4);
  let maxDuration = Number(capabilities.duration?.max ?? 20);
  let effectiveResolution = capabilities.fixed_resolution || args.resolution || capabilities.default_resolution;
  if (capabilities.fixed_resolution && args.resolution && args.resolution !== capabilities.fixed_resolution) {
    adjustments.push(`resolution ${args.resolution} is unsupported by ${config.model}; using fixed resolution ${capabilities.fixed_resolution}`);
  } else if (effectiveResolution && Array.isArray(capabilities.resolutions) && !capabilities.resolutions.includes(effectiveResolution)) {
    const fallback = capabilities.default_resolution || capabilities.resolutions[0];
    adjustments.push(`resolution ${effectiveResolution} is unsupported by ${config.model}; using ${fallback}`);
    effectiveResolution = fallback;
  }
  const sendResolution = capabilities.fixed_resolution ? capabilities.send_resolution === true : Boolean(effectiveResolution);
  const resolution = sendResolution ? effectiveResolution : undefined;
  if (effectiveResolution && capabilities.resolution_duration_max?.[effectiveResolution] !== undefined) {
    maxDuration = Math.min(maxDuration, Number(capabilities.resolution_duration_max[effectiveResolution]));
  }
  if (!Number.isInteger(duration) || duration < minDuration || duration > maxDuration) {
    const normalized = Math.min(maxDuration, Math.max(minDuration, Number.isFinite(duration) ? Math.round(duration) : minDuration));
    adjustments.push(`duration ${args.duration ?? "default"} is outside ${config.model}${effectiveResolution ? ` ${effectiveResolution}` : ""} range ${minDuration}-${maxDuration}s; using ${normalized}s`);
    duration = normalized;
  }
  const ratios = Array.isArray(capabilities.aspect_ratios) && capabilities.aspect_ratios.length ? capabilities.aspect_ratios : [...RATIOS];
  let aspectRatio = args["aspect-ratio"];
  if (aspectRatio && !ratios.includes(aspectRatio)) {
    adjustments.push(`aspect ratio ${aspectRatio} is unsupported by ${config.model}; using ${ratios[0]}`);
    aspectRatio = ratios[0];
  }
  if (adjustments.length) adjustments.forEach((message) => progress(args, `Parameter adjusted: ${message}.`));
  args.parameterAdjustments = adjustments;
  args.effectiveResolution = effectiveResolution;
  return { capabilities, duration, aspectRatio, resolution, effectiveResolution };
}

function supportsParameter(capabilities, name) {
  return !Array.isArray(capabilities.supported_parameters) || capabilities.supported_parameters.includes(name);
}

function parseBoolean(value, option) {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  die(`${option} must be true or false.`);
}

function parseMetadata(value) {
  if (value === undefined) return undefined;
  let metadata;
  try { metadata = JSON.parse(value); } catch (error) { die(`--metadata-json must be valid JSON: ${error.message}`); }
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") die("--metadata-json must contain a JSON object.");
  return metadata;
}

async function readPrompt(args) {
  if (args.prompt) return args.prompt;
  if (args["prompt-file"]) return fs.readFileSync(args["prompt-file"], "utf8").trim();
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const prompt = Buffer.concat(chunks).toString("utf8").trim();
    if (prompt) return prompt;
  }
  die("missing --prompt, --prompt-file, or stdin prompt.");
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
  })[ext] || "application/octet-stream";
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function findInputOptimizer() {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sips")) return { name: "sips", command: "/usr/bin/sips" };
  const result = spawnSync("magick", ["-version"], { stdio: "ignore" });
  return !result.error && result.status === 0 ? { name: "imagemagick", command: "magick" } : null;
}

function inputHasAlpha(filePath, optimizer) {
  if (optimizer.name === "sips") {
    const result = spawnSync(optimizer.command, ["-g", "hasAlpha", filePath], { encoding: "utf8" });
    return !result.error && result.status === 0 && /hasAlpha:\s*yes/i.test(result.stdout);
  }
  const result = spawnSync(optimizer.command, ["identify", "-format", "%[channels]", filePath], { encoding: "utf8" });
  return !result.error && result.status === 0 && /a/i.test(result.stdout);
}

function optimizeInputImages(args) {
  const originals = [...args.image];
  args.originalImages = originals;
  args.inputOptimization = [];
  if (args["no-input-optimization"] || originals.length === 0) return () => {};
  const maxDimension = Math.round(Number(args["max-input-dimension"] || 1536));
  const jpegQuality = Math.round(Number(args["input-jpeg-quality"] || 85));
  const thresholdBytes = Number(args["input-optimize-threshold-mb"] || 4) * 1024 * 1024;
  const optimizer = findInputOptimizer();
  let tempDir;
  const cleanup = () => { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); };
  args.image = originals.map((imagePath, index) => {
    if (!fs.existsSync(imagePath)) die(`image file not found: ${imagePath}`);
    const originalBytes = fs.statSync(imagePath).size;
    if (originalBytes <= thresholdBytes || !optimizer) {
      args.inputOptimization.push({ original: path.resolve(imagePath), optimized: false, reason: originalBytes <= thresholdBytes ? "below-threshold" : "optimizer-unavailable", bytes: originalBytes });
      return imagePath;
    }
    tempDir ||= fs.mkdtempSync(path.join(os.tmpdir(), "codex-video-input-"));
    const preserveAlpha = inputHasAlpha(imagePath, optimizer);
    const target = path.join(tempDir, `image-${index + 1}.${preserveAlpha ? "png" : "jpg"}`);
    const command = optimizer.name === "sips"
      ? ["-Z", String(maxDimension), "-s", "format", preserveAlpha ? "png" : "jpeg", ...(preserveAlpha ? [] : ["-s", "formatOptions", String(jpegQuality)]), imagePath, "--out", target]
      : [imagePath, "-auto-orient", "-resize", `${maxDimension}x${maxDimension}>`, ...(preserveAlpha ? [] : ["-quality", String(jpegQuality)]), target];
    const result = spawnSync(optimizer.command, command, { encoding: "utf8" });
    if (result.error || result.status !== 0 || !fs.existsSync(target)) {
      args.inputOptimization.push({ original: path.resolve(imagePath), optimized: false, reason: "optimizer-failed", bytes: originalBytes });
      return imagePath;
    }
    const optimizedBytes = fs.statSync(target).size;
    if (optimizedBytes >= originalBytes) { fs.rmSync(target, { force: true }); args.inputOptimization.push({ original: path.resolve(imagePath), optimized: false, reason: "no-size-benefit", bytes: originalBytes }); return imagePath; }
    progress(args, `Optimized image ${index + 1}/${originals.length}: ${formatBytes(originalBytes)} -> ${formatBytes(optimizedBytes)}.`);
    args.inputOptimization.push({ original: path.resolve(imagePath), optimized: true, path: target, original_bytes: originalBytes, optimized_bytes: optimizedBytes, optimizer: optimizer.name });
    return target;
  });
  return cleanup;
}

function buildRequest(prompt, args, config) {
  const normalized = normalizeVideoParameters(args, config);
  const { duration, aspectRatio, resolution } = normalized;
  const caps = normalized.capabilities;
  const imageCount = args.imageInputs.length;
  const videoCount = args.videoInputs.length;
  const audioCount = args.audioInputs.length;
  const maxImages = Number(caps.max_images ?? 9);
  const maxVideos = Number(caps.max_videos ?? 3);
  const maxAudios = Number(caps.max_audios ?? 3);
  if (imageCount && !supportsParameter(caps, "images")) die(`${config.model} does not support image references.`);
  if (videoCount && !supportsParameter(caps, "videos")) die(`${config.model} does not support video references. Remove --video/--video-url or use a model that supports them, such as minimax-h3-ref.`);
  if (audioCount && !supportsParameter(caps, "audios")) die(`${config.model} does not support audio references.`);
  if (imageCount > maxImages) die(`${config.model} accepts at most ${maxImages} reference images.`);
  if (videoCount > maxVideos) {
    if (maxVideos === 0) die(`${config.model} does not support video references. Remove --video/--video-url or use minimax-h3-ref.`);
    die(`${config.model} accepts at most ${maxVideos} reference videos.`);
  }
  if (audioCount > maxAudios) die(`${config.model} accepts at most ${maxAudios} reference audios.`);
  const total = imageCount + videoCount + audioCount;
  if (total > Number(caps.max_total_references ?? 12)) die(`reference images, videos, and audios combined must not exceed ${caps.max_total_references ?? 12}.`);
  const promptSource = args["prompt-source"] || "user";
  if (!["user", "codex-current-model", "minimax-context-ir"].includes(promptSource)) {
    die("--prompt-source must be user, codex-current-model, or minimax-context-ir.");
  }
  try {
    args.promptValidation = validateVideoPrompt({
      prompt,
      model: config.model,
      duration,
      imageCount,
      videoCount,
      audioCount,
      promptMode: args["prompt-mode"],
      promptSource,
      registry: loadVideoRegistry(),
    });
  } catch (error) {
    die(error.message || String(error));
  }

  const body = { model: config.model, prompt, duration, async: true };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (args["image-url"].length) body.images = args["image-url"];
  if (args["video-url"].length) body.videos = args["video-url"];
  if (args["audio-url"].length) body.audios = args["audio-url"];
  if (args["generate-audio"] !== undefined) {
    if (!supportsParameter(caps, "generate_audio")) die(`${config.model} does not support --generate-audio.`);
    body.generate_audio = parseBoolean(args["generate-audio"], "--generate-audio");
  }
  if (args.webhook) {
    if (!supportsParameter(caps, "webhook")) die(`${config.model} does not support --webhook.`);
    body.webhook = args.webhook;
  }
  if (args["metadata-json"] !== undefined) {
    if (!supportsParameter(caps, "metadata")) die(`${config.model} does not support --metadata-json.`);
    body.metadata = parseMetadata(args["metadata-json"]);
  }
  return body;
}

function appendFile(form, field, filePath) {
  if (!fs.existsSync(filePath)) die(`${field} file not found: ${filePath}`);
  form.append(field, new Blob([fs.readFileSync(filePath)], { type: mimeTypeFor(filePath) }), path.basename(filePath));
}

function buildMultipart(body, args) {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (!["images", "videos", "audios"].includes(key)) {
      form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  for (const item of args.imageInputs) item.key === "image-url" ? form.append("images", item.value) : appendFile(form, "images", item.value);
  for (const item of args.videoInputs) item.key === "video-url" ? form.append("videos", item.value) : appendFile(form, "videos", item.value);
  for (const item of args.audioInputs) item.key === "audio-url" ? form.append("audios", item.value) : appendFile(form, "audios", item.value);
  return form;
}

function hasLocalMedia(args) {
  return args.image.length > 0 || args.video.length > 0 || args.audio.length > 0;
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function requestJson(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { throw new HttpError(response.status, { raw: text.slice(0, 500) }); }
  if (!response.ok) throw new HttpError(response.status, json);
  return json;
}

function errorMessage(body) {
  return body?.error?.message || body?.error || body?.failure_reason || body?.message || JSON.stringify(body).slice(0, 1000);
}

function statusOf(body) { return String(body?.status || "").toLowerCase(); }

function videoUrlOf(body) {
  return body?.data?.find?.((item) => item?.video_url)?.video_url || body?.video_url || null;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function pollIntervalMs(args) {
  const value = Number(args["poll-interval"] ?? DEFAULT_POLL_INTERVAL_SECONDS);
  const seconds = Number.isFinite(value) ? Math.max(1, value) : DEFAULT_POLL_INTERVAL_SECONDS;
  return seconds * 1000;
}

async function waitForVideo(id, args, config, initial) {
  let current = initial;
  const started = Date.now();
  const timeoutMs = Number(args.timeout || 1800) * 1000;
  const stateFile = taskStatePath(args, args.out || "generated.mp4");
  let attempt = 0;
  const configuredDelayMs = pollIntervalMs(args);
  let delayMs = configuredDelayMs;
  while (true) {
    const status = statusOf(current);
    const url = videoUrlOf(current);
    if (status === "succeeded" && url) {
      writeTaskState(stateFile, { id, status: "succeeded", progress: current.progress ?? 100, created: current.created, model: current.model || config.model, video_url: url, output: args.out, updated_at: new Date().toISOString() });
      return { ...current, video_url: url };
    }
    if (["failed", "cancelled", "canceled"].includes(status)) die(`video task ${id} failed: ${errorMessage(current)}`);
    if (Date.now() - started > timeoutMs) die(`timed out waiting for video task ${id}; use --resume ${id} to continue later.`);
    const elapsed = Math.round((Date.now() - started) / 1000);
    progress(args, `Video task ${id}: ${status || "unknown"}${current.progress !== undefined ? ` (${current.progress}%)` : ""}; waited ${elapsed}s.`);
    await sleep(delayMs);
    try {
      current = await requestJson(`${config.statusUrl}/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      writeTaskState(stateFile, { id, status: current.status, progress: current.progress, created: current.created, model: current.model || config.model, output: args.out, updated_at: new Date().toISOString() });
      attempt = 0;
      delayMs = configuredDelayMs;
      const retryAfter = Number(current?.retry_after || current?.retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) delayMs = retryAfter * 1000;
    } catch (error) {
      if (!transientNetworkError(error) || Date.now() - started > timeoutMs) {
        die(`temporary network error while polling video task ${id}: ${error.message || error}. The task may still be running; resume with --resume ${id}.`);
      }
      attempt += 1;
      const code = error instanceof HttpError ? `HTTP ${error.status}` : (error.message || "network error");
      delayMs = Math.min(60000, 1000 * (2 ** Math.min(attempt, 6)));
      progress(args, `Status check failed (${code}); retrying (${attempt}) in ${Math.round(delayMs / 1000)}s. Task ${id} is not being recreated.`);
    }
  }
}

async function downloadVideo(url, outputPath, config) {
  const hostname = new URL(url).hostname.toLowerCase();
  const isCumobHost = hostname === "cumob.com" || hostname.endsWith(".cumob.com");
  const response = await fetch(url, { headers: { ...(isCumobHost ? { Authorization: `Bearer ${config.apiKey}` } : {}) } });
  if (!response.ok || !response.body) die(`failed to download generated video: HTTP ${response.status}`);
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.part-${crypto.randomUUID()}`;
  const handle = fs.createWriteStream(temp);
  try {
    for await (const chunk of response.body) handle.write(Buffer.from(chunk));
  } finally {
    await new Promise((resolve) => handle.end(resolve));
  }
  if (fs.statSync(temp).size === 0) { fs.rmSync(temp, { force: true }); die("downloaded video is empty."); }
  fs.renameSync(temp, absolute);
  return outputPath;
}

async function main() {
  if (typeof fetch !== "function") die("Node.js 18+ is required.");
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP.trim()); return; }
  const config = resolveConfig(args);
  const outputPath = args.out || "generated.mp4";
  const stateFile = taskStatePath(args, outputPath);
  let prompt = args.prompt;
  if (!args.resume) prompt = await readPrompt(args);
  const resumeState = args.resume ? (fs.existsSync(args.resume) ? readTaskState(path.resolve(args.resume)) : readTaskState(stateFile)) : null;
  const resumeId = resumeState?.id || args.resume;
  const cleanupImages = resumeId ? () => {} : optimizeInputImages(args);
  try {
  const body = resumeId ? null : buildRequest(prompt, args, config);
  if (args["dry-run"]) {
    console.log(JSON.stringify({
      provider: config.providerName, base_url: config.baseUrl, create_endpoint: config.createUrl,
      status_endpoint: `${config.statusUrl}/{id}`, video_model: config.model,
      transport: hasLocalMedia(args) ? "multipart/form-data" : "application/json",
      has_api_key: config.hasApiKey, api_key_source: config.apiKeySource,
      request: body ? { ...body, images: body.images, multipart_files: { images: args.image, videos: args.video, audios: args.audio }, input_optimization: args.inputOptimization } : null,
      effective_resolution: args.effectiveResolution || loadVideoCapabilities(config.model).fixed_resolution || body?.resolution || null,
      resolution_sent: Boolean(body && Object.hasOwn(body, "resolution")),
      parameter_adjustments: args.parameterAdjustments || [],
      prompt_validation: args.promptValidation || null,
      prompt_file: args["prompt-file"] ? path.resolve(args["prompt-file"]) : null,
      resume_id: resumeId || null, task_file: stateFile, output: outputPath,
    }, null, 2));
    return;
  }

  let task;
  if (resumeId) {
    progress(args, `Resuming existing video task ${resumeId}; no create request will be sent.`);
    task = { id: resumeId, status: "queued" };
  } else {
    progress(args, "Creating video task. Only one create request will be sent.");
    try {
      const localMedia = hasLocalMedia(args);
      task = await requestJson(config.createUrl, localMedia
        ? { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}` }, body: buildMultipart(body, args) }
        : { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      if (error instanceof HttpError) die(`video API request failed with status ${error.status}: ${errorMessage(error.body)}`);
      die(`video create request could not be confirmed: ${error.message || error}. Do not retry blindly; check CUMOB task history before creating another task.`);
    }
  }
  const id = task.id || resumeId;
  if (!id) die("video API response did not contain an id.");
  writeTaskState(stateFile, { id, status: task.status, progress: task.progress, created: task.created, model: task.model || config.model, output: outputPath, prompt_file: args["prompt-file"] ? path.resolve(args["prompt-file"]) : null, prompt_validation: args.promptValidation || null, updated_at: new Date().toISOString() });
  const completed = videoUrlOf(task) && statusOf(task) === "succeeded" ? { ...task, video_url: videoUrlOf(task) } : await waitForVideo(id, args, config, task);
  progress(args, "Video is ready. Downloading content.");
  const written = await downloadVideo(completed.video_url, outputPath, config);
  const summary = { id, status: completed.status, provider: config.providerName, model: completed.model || config.model, requested_duration: args.duration === undefined ? null : Number(args.duration), duration: completed.duration || body?.duration, aspect_ratio: completed.aspect_ratio || body?.aspect_ratio, resolution: completed.resolution || args.effectiveResolution || loadVideoCapabilities(config.model).fixed_resolution || body?.resolution || null, parameter_adjustments: args.parameterAdjustments || [], prompt_file: args["prompt-file"] ? path.resolve(args["prompt-file"]) : null, prompt_validation: args.promptValidation || null, video_url: completed.video_url, output: written };
  if (args.json) console.log(JSON.stringify(summary, null, 2)); else console.log(`Wrote ${written}`);
  } finally {
    cleanupImages();
  }
}

main().catch((error) => die(error.stack || error.message || String(error)));
