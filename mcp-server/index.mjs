#!/usr/bin/env node
// CUMOB Media Generation MCP Server
// Exposes generate_image and generate_video as MCP tools for Claude Desktop.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Resolve paths ──────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(SKILL_ROOT, "outputs");
const VIDEO_MODELS = JSON.parse(
  fs.readFileSync(path.join(SKILL_ROOT, "video-models.json"), "utf8")
);

// ── Config resolution (reuse media-common logic) ───────────
function env(name) {
  if (process.env[name] !== undefined) return process.env[name];
  const wanted = name.toLowerCase();
  return Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === wanted
  )?.[1];
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value);
  return Number.isFinite(number) && value !== "" ? number : value;
}

function parseToml(text) {
  const result = { root: {}, sections: {} };
  let current = result.root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = result.sections[section[1]] ||= {};
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (match)
      current[match[1]] = parseTomlValue(match[2].replace(/\s+#.*$/, ""));
  }
  return result;
}

function readClaudeCodeConfig() {
  const claudeHome = path.join(os.homedir(), ".claude");
  const settings = readJson(path.join(claudeHome, "settings.json"));
  const localSettings = readJson(path.join(claudeHome, "settings.local.json"));
  return { ...settings.env, ...localSettings.env };
}

function resolveConfig(kind) {
  const codexHome = path.resolve(
    env("CODEX_HOME") || path.join(os.homedir(), ".codex")
  );
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const config = fs.existsSync(configPath)
    ? parseToml(fs.readFileSync(configPath, "utf8"))
    : { root: {}, sections: {} };
  const providerName = config.root.model_provider || "OpenAI";
  const provider =
    config.sections[`model_providers.${providerName}`] || {};
  const auth = readJson(authPath);
  const claudeEnv = readClaudeCodeConfig();

  const apiKey =
    env("CUMOB_API_KEY") ||
    auth.OPENAI_API_KEY ||
    claudeEnv.CUMOB_API_KEY ||
    claudeEnv.OPENAI_API_KEY ||
    env("OPENAI_API_KEY") ||
    env("ANTHROPIC_API_KEY");

  const defaultBase = "https://api.cumob.com/v1";
  const baseUrl = String(
    env("CUMOB_BASE_URL") ||
      provider.base_url ||
      claudeEnv.CUMOB_BASE_URL ||
      claudeEnv.OPENAI_BASE_URL ||
      env("OPENAI_BASE_URL") ||
      defaultBase
  ).replace(/\/+$/, "");

  const modelKey = kind === "image" ? "image_model" : "video_model";
  const cumobModelEnv =
    kind === "image" ? "CUMOB_IMAGE_MODEL" : "CUMOB_VIDEO_MODEL";
  const openaiModelEnv =
    kind === "image" ? "OPENAI_IMAGE_MODEL" : "OPENAI_VIDEO_MODEL";
  const fallbackModel = kind === "image" ? "gpt-image-2.5" : "minimax-h3";
  const model =
    env(cumobModelEnv) ||
    provider[modelKey] ||
    claudeEnv[cumobModelEnv] ||
    claudeEnv[openaiModelEnv] ||
    env(openaiModelEnv) ||
    fallbackModel;

  return { baseUrl, model, apiKey };
}

// ── HTTP helpers ───────────────────────────────────────────
class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function requestJson(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!response.ok) throw new HttpError(response.status, body);
  return body;
}

function errorMessage(body) {
  const reason = body?.failure_reason;
  const detail = body?.error?.message || body?.error || body?.message;
  if (reason)
    return detail && detail !== "error" && detail !== reason
      ? `${reason}: ${detail}`
      : String(reason);
  return detail || JSON.stringify(body).slice(0, 1000);
}

function transient(error) {
  return (
    !(error instanceof HttpError) ||
    [408, 425, 429, 500, 502, 503, 504].includes(error.status)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollTask({
  id,
  statusUrl,
  headers,
  completed,
  firstIntervalMs = 30000,
  subsequentIntervalMs = 30000,
  timeoutMs = 1800000,
  onProgress,
}) {
  const started = Date.now();
  let current = { id, status: "queued" };
  let delay = firstIntervalMs;
  let failures = 0;
  while (true) {
    if (completed(current)) return current;
    const status = String(current?.status || "").toLowerCase();
    if (["failed", "cancelled", "canceled"].includes(status)) {
      throw new Error(`Task ${id} failed: ${errorMessage(current)}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for task ${id}`);
    }
    if (onProgress) onProgress(status, current.progress);
    await sleep(delay);
    try {
      current = await requestJson(
        `${statusUrl}/${encodeURIComponent(id)}`,
        { headers }
      );
      failures = 0;
      const retryAfter = Number(current.retry_after || current.retryAfter);
      delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : subsequentIntervalMs;
    } catch (error) {
      if (!transient(error)) throw error;
      failures += 1;
      delay = Math.min(10000, 1000 * 2 ** Math.min(failures, 4));
    }
  }
}

async function downloadToFile(url, output, apiKey) {
  const hostname = new URL(url).hostname.toLowerCase();
  const auth =
    hostname === "cumob.com" || hostname.endsWith(".cumob.com")
      ? { Authorization: `Bearer ${apiKey}` }
      : {};
  const response = await fetch(url, { headers: auth });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const absolute = path.resolve(output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.part-${process.pid}`;
  const stream = fs.createWriteStream(temp);
  for await (const chunk of response.body) stream.write(Buffer.from(chunk));
  await new Promise((resolve) => stream.end(resolve));
  if (!fs.statSync(temp).size) throw new Error("Downloaded file is empty");
  fs.renameSync(temp, absolute);
  return absolute;
}

// ── Image generation ──────────────────────────────────────
async function generateImage({
  prompt,
  model: requestedModel,
  size,
  quality,
  format,
  background,
  image_urls,
  output_path,
}) {
  const config = resolveConfig("image");
  if (!config.apiKey) throw new Error("No API key configured");

  const model = requestedModel || config.model;
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  const fmt = format || "png";
  const outPath = output_path || path.join(DEFAULT_OUTPUT_DIR, `image-${Date.now()}.${fmt}`);

  const fields = { model, prompt, async: true };
  if (image_urls?.length) fields.images = image_urls;
  if (size) fields.size = size;
  if (quality) fields.quality = quality;
  if (format) fields.output_format = format;
  if (background) fields.background = background;

  const endpoint = `${config.baseUrl}/images/generations`;
  let task;
  try {
    task = await requestJson(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
  } catch (error) {
    throw new Error(
      `Image request failed: ${errorMessage(error.body || error)}`
    );
  }

  const hasImageData = (t) =>
    Array.isArray(t?.data) && t.data.some((item) => item?.url || item?.b64_json);

  if (!hasImageData(task) && !task.id) {
    throw new Error("API returned neither image data nor a task id");
  }

  if (!hasImageData(task) && task.id) {
    task = await pollTask({
      id: task.id,
      statusUrl: `${config.baseUrl}/status`,
      headers,
      completed: (v) =>
        String(v?.status).toLowerCase() === "succeeded" && hasImageData(v),
      firstIntervalMs: 30000,
      subsequentIntervalMs: 15000,
    });
  }

  if (!hasImageData(task)) {
    throw new Error(`Image task returned no image data: ${errorMessage(task)}`);
  }

  // Save image(s)
  const files = [];
  for (let i = 0; i < task.data.length; i++) {
    const item = task.data[i];
    const target =
      task.data.length === 1
        ? outPath
        : outPath.replace(/(\.[^.]+)$/, `-${i + 1}$1`);
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    if (item.b64_json) {
      fs.writeFileSync(target, Buffer.from(item.b64_json, "base64"));
    } else {
      await downloadToFile(item.url, target, config.apiKey);
    }
    files.push(path.resolve(target));
  }

  return { model, files, task_id: task.id };
}

// ── Video generation ──────────────────────────────────────
async function generateVideo({
  prompt,
  model: requestedModel,
  duration,
  aspect_ratio,
  resolution,
  image_urls,
  video_urls,
  audio_urls,
  generate_audio,
  output_path,
}) {
  const config = resolveConfig("video");
  if (!config.apiKey) throw new Error("No API key configured");

  let model = requestedModel || config.model;
  model = VIDEO_MODELS.model_aliases?.[model] || model;
  const capabilities = VIDEO_MODELS.models?.[model] || {
    duration: { min: 3, max: 20, default: 10 },
  };

  const headers = { Authorization: `Bearer ${config.apiKey}` };
  const outPath = output_path || path.join(DEFAULT_OUTPUT_DIR, `video-${Date.now()}.mp4`);

  // Validate and clamp duration
  const limits = capabilities.duration || { min: 3, max: 20, default: 10 };
  let dur = duration === undefined ? limits.default : Math.round(Number(duration));
  if (!Number.isFinite(dur)) dur = limits.default;
  const resolutionValue = capabilities.fixed_resolution || resolution || capabilities.default_resolution;
  const resMax = capabilities.resolution_duration_max?.[resolutionValue];
  dur = Math.min(resMax ?? limits.max, Math.max(limits.min, dur));

  // Validate aspect ratio
  if (aspect_ratio && capabilities.aspect_ratios && !capabilities.aspect_ratios.includes(aspect_ratio)) {
    throw new Error(`Unsupported aspect ratio for ${model}: ${aspect_ratio}. Supported: ${capabilities.aspect_ratios.join(", ")}`);
  }

  // Validate references
  const imgCount = image_urls?.length || 0;
  const vidCount = video_urls?.length || 0;
  const audCount = audio_urls?.length || 0;
  if (imgCount > (capabilities.max_images ?? Infinity))
    throw new Error(`${model} accepts at most ${capabilities.max_images} image references`);
  if (vidCount > (capabilities.max_videos ?? Infinity))
    throw new Error(
      capabilities.max_videos === 0
        ? `${model} does not support video references`
        : `${model} accepts at most ${capabilities.max_videos} video references`
    );
  if (audCount > (capabilities.max_audios ?? Infinity))
    throw new Error(`${model} accepts at most ${capabilities.max_audios} audio references`);

  const body = { model, prompt, duration: dur, async: true };
  if (aspect_ratio) body.aspect_ratio = aspect_ratio;
  if (resolutionValue && !capabilities.fixed_resolution)
    body.resolution = resolutionValue;
  if (image_urls?.length) body.images = image_urls;
  if (video_urls?.length) body.videos = video_urls;
  if (audio_urls?.length) body.audios = audio_urls;
  if (generate_audio !== undefined) body.generate_audio = generate_audio;

  const endpoint = `${config.baseUrl}/videos`;
  let task;
  try {
    task = await requestJson(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `Video request failed: ${errorMessage(error.body || error)}`
    );
  }

  if (!task.id) throw new Error("Video API returned no task id");

  const videoUrl = (t) =>
    t?.video_url ||
    t?.data?.find?.((item) => item?.video_url)?.video_url ||
    null;

  if (!videoUrl(task)) {
    task = await pollTask({
      id: task.id,
      statusUrl: `${config.baseUrl}/status`,
      headers,
      completed: (v) =>
        String(v?.status).toLowerCase() === "succeeded" &&
        Boolean(videoUrl(v)),
      firstIntervalMs: 30000,
      subsequentIntervalMs: 30000,
    });
  }

  const url = videoUrl(task);
  if (!url) throw new Error("Video task completed without a video URL");

  const filePath = await downloadToFile(url, outPath, config.apiKey);
  return { model, file: filePath, task_id: task.id, duration: dur };
}

// ── MCP Server setup ──────────────────────────────────────
const server = new Server(
  { name: "cumob-media", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description:
        "Generate or edit images using the CUMOB API gateway. Supports multiple models (gpt-image-2.5, gemini-3-pro-image-preview, etc). Returns the local file path of the generated image.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Image description / generation prompt",
          },
          model: {
            type: "string",
            description:
              "Image model to use (default: gpt-image-2.5). Options include gemini-3-pro-image-preview, gemini-3.1-flash-image-preview",
          },
          size: {
            type: "string",
            description: "Image size, e.g. 1024x1024, 1080x1440",
          },
          quality: {
            type: "string",
            enum: ["low", "medium", "high", "auto"],
            description: "Image quality",
          },
          format: {
            type: "string",
            enum: ["png", "webp", "jpeg"],
            description: "Output format (default: png)",
          },
          background: {
            type: "string",
            enum: ["transparent", "opaque", "auto"],
            description: "Background style",
          },
          image_urls: {
            type: "array",
            items: { type: "string" },
            description: "Reference image URLs for editing/inspiration",
          },
          output_path: {
            type: "string",
            description:
              "Local file path to save the image. Default: <skill-dir>/outputs/image-{timestamp}.png",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "generate_video",
      description:
        "Generate videos using the CUMOB API gateway. Supports models like minimax-h3, minimax-h3-2k, minimax-h3-fhd, agnes-video-v2.0. Returns the local file path of the generated video.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Video description / generation prompt",
          },
          model: {
            type: "string",
            description:
              "Video model (default: minimax-h3). Options: minimax-h3, minimax-h3-2k, minimax-h3-fhd, agnes-video-v2.0",
          },
          duration: {
            type: "number",
            description: "Video duration in seconds (clamped to model limits)",
          },
          aspect_ratio: {
            type: "string",
            description:
              "Aspect ratio, e.g. 16:9, 9:16, 1:1 (varies by model)",
          },
          resolution: {
            type: "string",
            description: "Resolution, e.g. 480p, 720p, 1080p (varies by model)",
          },
          image_urls: {
            type: "array",
            items: { type: "string" },
            description: "Reference image URLs",
          },
          video_urls: {
            type: "array",
            items: { type: "string" },
            description: "Reference video URLs",
          },
          audio_urls: {
            type: "array",
            items: { type: "string" },
            description: "Reference audio URLs",
          },
          generate_audio: {
            type: "boolean",
            description: "Whether to generate audio for the video",
          },
          output_path: {
            type: "string",
            description:
              "Local file path to save the video. Default: <skill-dir>/outputs/video-{timestamp}.mp4",
          },
        },
        required: ["prompt"],
      },
    },
  ],
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "generate_image") {
      const result = await generateImage(args);
      return {
        content: [
          {
            type: "text",
            text: `Image generated successfully!\n\nModel: ${result.model}\nTask ID: ${result.task_id || "N/A"}\nSaved to: ${result.files.join(", ")}\n\nThe image has been saved to your local filesystem.`,
          },
        ],
      };
    }

    if (name === "generate_video") {
      const result = await generateVideo(args);
      return {
        content: [
          {
            type: "text",
            text: `Video generated successfully!\n\nModel: ${result.model}\nTask ID: ${result.task_id || "N/A"}\nDuration: ${result.duration}s\nSaved to: ${result.file}\n\nThe video has been saved to your local filesystem.`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CUMOB Media MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
