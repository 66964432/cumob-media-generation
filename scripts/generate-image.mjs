#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_POLL_INTERVAL_SECONDS = 30;

const HELP = `
Usage:
  node scripts/generate-image.mjs --prompt "..." --out outputs/image.png [options]

Required:
  --prompt <text>             Image prompt. Use --prompt-file or stdin as alternatives.

Output:
  --out <path>                Output image path. Default: generated.png

Codex config:
  --codex-home <path>         Defaults to $CODEX_HOME or <home>/.codex on Linux, macOS, and Windows
  --base-url <url>            Explicit override. Defaults to Codex provider base_url.
  --image-api <api>           Override provider image_api: responses or images.
  --response-model <model>    Explicit override. Defaults to Codex top-level model.
  --api-key-env <name>        Environment variable fallback for the API key. Default: OPENAI_API_KEY.

Image generation options:
  --action <generate|edit|auto>
  --image <path>              Input image. Can be repeated.
  --mask <path>               Optional inpainting mask image.
  --image-model <model>
  --size <size>
  --quality <low|medium|high|auto>
  --format <png|webp|jpeg>
  --background <transparent|opaque|auto>
  --input-fidelity <high|low>
  --moderation <auto|low>
  --output-compression <0-100>
  --partial-images <0-3>
  --max-input-dimension <pixels>  Local input resize limit. Default: 1536.
  --input-jpeg-quality <1-100>    Local JPEG quality. Default: 85.
  --input-optimize-threshold-mb <number>
                                Optimize inputs larger than this. Default: 4.

Other:
  --no-input-optimization     Upload original input images without local preprocessing.
  --poll-interval <seconds>   Status poll interval. Default: ${DEFAULT_POLL_INTERVAL_SECONDS}.
  --timeout <seconds>         Overall async task timeout. Default: 1800.
  --resume <id-or-file>       Resume an existing CUMOB image task without creating a new task.
  --task-file <path>          Persist image task state. Default: <out>.task.json.
  --dry-run                   Print redacted config and request body without calling the API.
  --json                      Print machine-readable result summary.
  --no-progress               Disable progress messages on stderr while waiting for the API.
  --help

Runtime:
  Requires Node.js 18+ only. No npm packages are needed.
`;

function die(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function progress(args, message) {
  if (!args["no-progress"]) {
    console.error(`[image-generation] ${message}`);
  }
}

function startProgress(args) {
  if (args["no-progress"]) return () => {};

  const startedAt = Date.now();
  progress(args, "Request sent. Image generation can take several minutes; wait for this command to finish before retrying.");
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    progress(args, `Still waiting for image result (${elapsedSeconds}s elapsed). Do not start another generation for the same request unless this command fails.`);
  }, 15000);
  if (typeof timer.unref === "function") timer.unref();

  return () => clearInterval(timer);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function pollIntervalMs(args) {
  const value = Number(args["poll-interval"] ?? DEFAULT_POLL_INTERVAL_SECONDS);
  const seconds = Number.isFinite(value) ? Math.max(1, value) : DEFAULT_POLL_INTERVAL_SECONDS;
  return seconds * 1000;
}

function taskStatePath(args, outputPath) {
  return path.resolve(args["task-file"] || `${outputPath}.task.json`);
}

function writeTaskState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, filePath);
}

function readTaskState(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) { die(`failed to parse task file ${filePath}: ${error.message}`); }
}

class HttpError extends Error {
  constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; }
}

function transientError(error) {
  if (error instanceof HttpError) return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  return error?.name === "TypeError" || error?.name === "AbortError" || /fetch failed|network|timeout|reset|socket|connect/i.test(error?.message || "");
}

function apiErrorMessage(body) {
  return body?.error?.message || body?.error || body?.failure_reason || body?.message || JSON.stringify(body).slice(0, 1000);
}

async function requestJson(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try { response = await fetch(url, { ...options, signal: options.signal || controller.signal }); }
  finally { clearTimeout(timer); }
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { throw new HttpError(response.status, { raw: text.slice(0, 500) }); }
  if (!response.ok) throw new HttpError(response.status, json);
  return json;
}

function parseArgs(argv) {
  const args = { image: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      die(`unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (key === "api-key") {
      die("--api-key was removed to avoid exposing secrets in command lines. Use Codex auth.json or --api-key-env <name>.");
    }
    if (["help", "dry-run", "json", "no-progress", "no-input-optimization"].includes(key)) {
      args[key] = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      die(`missing value for --${key}`);
    }
    i += 1;

    if (key === "image") {
      args.image.push(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
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

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1].replaceAll('"', "");
      sections[section] = sections[section] || {};
      current = sections[section];
      continue;
    }

    const keyValueMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyValueMatch) continue;
    const [, key, rawValue] = keyValueMatch;
    current[key] = parseTomlValue(rawValue);
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
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function validateEnvName(name, optionName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    die(`${optionName} must be an environment variable name, not a secret value.`);
  }
}

function defaultCodexHome() {
  return path.resolve(envValue("CODEX_HOME") || path.join(os.homedir(), ".codex"));
}

function resolveCodexConfig(args) {
  const codexHome = args["codex-home"] ? path.resolve(args["codex-home"]) : defaultCodexHome();
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");

  let codexConfig = { root: {}, sections: {} };
  if (fs.existsSync(configPath)) {
    codexConfig = parseTomlLite(fs.readFileSync(configPath, "utf8"));
  }

  const providerName = codexConfig.root.model_provider || "OpenAI";
  const provider = codexConfig.sections[`model_providers.${providerName}`] || {};
  const auth = readJsonIfExists(authPath);
  const apiKeyEnvName = args["api-key-env"] || "OPENAI_API_KEY";
  validateEnvName(apiKeyEnvName, "--api-key-env");

  const baseUrl = args["base-url"] || provider.base_url || envValue("OPENAI_BASE_URL") || "https://api.openai.com/v1";
  const imageApi = String(
    args["image-api"] || provider.image_api || envValue("OPENAI_IMAGE_API") || "responses",
  ).toLowerCase();
  const imageModel = args["image-model"] || provider.image_model || envValue("OPENAI_IMAGE_MODEL");
  const responseModel = args["response-model"] || codexConfig.root.model || envValue("OPENAI_MODEL");
  const authApiKey = auth.OPENAI_API_KEY;
  const envApiKey = envValue(apiKeyEnvName);
  const apiKey = authApiKey || envApiKey;
  const apiKeySource = authApiKey ? "codex-auth" : envApiKey ? `env:${apiKeyEnvName}` : "none";

  if (!["responses", "images"].includes(imageApi)) {
    die(`unsupported image API: ${imageApi}. Expected responses or images.`);
  }
  if (imageApi === "responses" && !responseModel) {
    die("no Responses model found. Set Codex top-level model or pass --response-model.");
  }
  if (!apiKey && !args["dry-run"]) {
    die(`no API key found. Expected OPENAI_API_KEY in Codex auth.json or environment variable ${apiKeyEnvName}.`);
  }

  return {
    codexHome,
    configPath,
    authPath,
    providerName,
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    imageApi,
    imageModel,
    responseModel,
    apiKey,
    apiKeySource,
    hasApiKey: Boolean(apiKey),
  };
}

async function readPrompt(args) {
  if (args.prompt) return args.prompt;
  if (args["prompt-file"]) return fs.readFileSync(args["prompt-file"], "utf8").trim();
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const stdinPrompt = Buffer.concat(chunks).toString("utf8").trim();
    if (stdinPrompt) return stdinPrompt;
  }
  die("missing --prompt, --prompt-file, or stdin prompt.");
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function imageFileToDataUrl(filePath) {
  if (!fs.existsSync(filePath)) die(`image file not found: ${filePath}`);
  const data = fs.readFileSync(filePath).toString("base64");
  return `data:${mimeTypeFor(filePath)};base64,${data}`;
}

function numericOption(args, key, defaultValue, minimum, maximum) {
  if (args[key] === undefined) return defaultValue;
  const value = Number(args[key]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    die(`--${key} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function findInputOptimizer() {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sips")) {
    return { name: "sips", command: "/usr/bin/sips" };
  }
  const magick = spawnSync("magick", ["-version"], { stdio: "ignore" });
  if (!magick.error && magick.status === 0) {
    return { name: "imagemagick", command: "magick" };
  }
  return null;
}

function inputHasAlpha(imagePath, optimizer) {
  if (optimizer.name === "sips") {
    const result = spawnSync(optimizer.command, ["-g", "hasAlpha", imagePath], {
      encoding: "utf8",
    });
    return !result.error && result.status === 0 && /hasAlpha:\s*yes/i.test(result.stdout);
  }
  const result = spawnSync(
    optimizer.command,
    ["identify", "-format", "%[channels]", imagePath],
    { encoding: "utf8" },
  );
  return !result.error && result.status === 0 && /a/i.test(result.stdout);
}

function optimizeInputImages(args) {
  const originals = [...args.image];
  args.originalImages = originals;
  args.inputOptimization = [];
  if (args["no-input-optimization"] || originals.length === 0) {
    return () => {};
  }

  const maxDimension = Math.round(numericOption(args, "max-input-dimension", 1536, 256, 8192));
  const jpegQuality = Math.round(numericOption(args, "input-jpeg-quality", 85, 1, 100));
  const thresholdMb = numericOption(args, "input-optimize-threshold-mb", 4, 0, 1024);
  const thresholdBytes = thresholdMb * 1024 * 1024;
  const optimizer = findInputOptimizer();
  let tempDir;
  const cleanup = () => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  };
  process.once("exit", cleanup);

  args.image = originals.map((imagePath, index) => {
    if (!fs.existsSync(imagePath)) die(`image file not found: ${imagePath}`);
    const originalBytes = fs.statSync(imagePath).size;
    if (originalBytes <= thresholdBytes) {
      args.inputOptimization.push({
        original: path.resolve(imagePath),
        optimized: false,
        reason: "below-threshold",
        bytes: originalBytes,
      });
      return imagePath;
    }
    if (!optimizer) {
      progress(args, `Input ${imagePath} is ${formatBytes(originalBytes)}, but no local optimizer is available; using the original file.`);
      args.inputOptimization.push({
        original: path.resolve(imagePath),
        optimized: false,
        reason: "optimizer-unavailable",
        bytes: originalBytes,
      });
      return imagePath;
    }

    tempDir ||= fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-input-"));
    const preserveAlpha = inputHasAlpha(imagePath, optimizer);
    const targetFormat = preserveAlpha ? "png" : "jpeg";
    const target = path.join(tempDir, `input-${index + 1}.${preserveAlpha ? "png" : "jpg"}`);
    let result;
    if (optimizer.name === "sips") {
      const sipsArgs = [
        "-Z", String(maxDimension),
        "-s", "format", targetFormat,
      ];
      if (!preserveAlpha) {
        sipsArgs.push("-s", "formatOptions", String(jpegQuality));
      }
      sipsArgs.push(imagePath, "--out", target);
      result = spawnSync(
        optimizer.command,
        sipsArgs,
        { encoding: "utf8" },
      );
    } else {
      const magickArgs = [
        imagePath,
        "-auto-orient",
        "-resize", `${maxDimension}x${maxDimension}>`,
      ];
      if (!preserveAlpha) {
        magickArgs.push("-quality", String(jpegQuality));
      }
      magickArgs.push(target);
      result = spawnSync(
        optimizer.command,
        magickArgs,
        { encoding: "utf8" },
      );
    }

    if (result.error || result.status !== 0 || !fs.existsSync(target)) {
      progress(args, `Local optimization failed for ${imagePath}; using the original file.`);
      args.inputOptimization.push({
        original: path.resolve(imagePath),
        optimized: false,
        reason: "optimizer-failed",
        bytes: originalBytes,
      });
      return imagePath;
    }

    const optimizedBytes = fs.statSync(target).size;
    if (optimizedBytes >= originalBytes) {
      fs.rmSync(target, { force: true });
      args.inputOptimization.push({
        original: path.resolve(imagePath),
        optimized: false,
        reason: "no-size-benefit",
        bytes: originalBytes,
      });
      return imagePath;
    }

    progress(
      args,
      `Optimized input ${index + 1}/${originals.length} locally with ${optimizer.name}: ${formatBytes(originalBytes)} -> ${formatBytes(optimizedBytes)}.`,
    );
    args.inputOptimization.push({
      original: path.resolve(imagePath),
      path: target,
      optimized: true,
      optimizer: optimizer.name,
      original_bytes: originalBytes,
      optimized_bytes: optimizedBytes,
      max_dimension: maxDimension,
      output_format: targetFormat,
      jpeg_quality: preserveAlpha ? undefined : jpegQuality,
    });
    return target;
  });

  return () => {
    process.removeListener("exit", cleanup);
    cleanup();
  };
}

function buildTool(args) {
  const tool = { type: "image_generation" };
  const optionMap = {
    action: "action",
    background: "background",
    "input-fidelity": "input_fidelity",
    "image-model": "model",
    moderation: "moderation",
    "output-compression": "output_compression",
    format: "output_format",
    "partial-images": "partial_images",
    quality: "quality",
    size: "size",
  };

  for (const [argName, bodyName] of Object.entries(optionMap)) {
    if (args[argName] === undefined) continue;
    if (["output-compression", "partial-images"].includes(argName)) {
      const numberValue = Number(args[argName]);
      if (!Number.isFinite(numberValue)) die(`--${argName} must be a number`);
      tool[bodyName] = numberValue;
    } else {
      tool[bodyName] = args[argName];
    }
  }

  if (args.mask) {
    tool.input_image_mask = { image_url: imageFileToDataUrl(args.mask) };
  }

  if (!tool.action && (!args.image || args.image.length === 0)) {
    tool.action = "generate";
  }

  return tool;
}

function buildInput(prompt, args) {
  if (!args.image || args.image.length === 0) return prompt;

  return [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        ...args.image.map((imagePath) => ({
          type: "input_image",
          image_url: imageFileToDataUrl(imagePath),
        })),
      ],
    },
  ];
}

function outputPathFor(basePath, index, count, format) {
  if (count === 1) return basePath;
  const parsed = path.parse(basePath);
  const ext = parsed.ext || `.${format || "png"}`;
  return path.join(parsed.dir, `${parsed.name}-${index + 1}${ext}`);
}

function redactRequest(body) {
  return JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === "image_url" && typeof value === "string" && value.startsWith("data:")) {
        return value.slice(0, value.indexOf(",") + 1) + "<base64-redacted>";
      }
      return value;
    }),
  );
}

function summarizeResponse(responseJson) {
  return {
    id: responseJson.id,
    status: responseJson.status,
    error: responseJson.error?.message || responseJson.error,
    output: (responseJson.output || []).map((item) => ({
      type: item.type,
      status: item.status,
      role: item.role,
      content_types: Array.isArray(item.content) ? item.content.map((content) => content.type) : undefined,
      error: item.error?.message || item.error,
    })),
  };
}

function resolveAction(args) {
  if (args.action && args.action !== "auto") return args.action;
  return args.image.length > 0 || args.mask ? "edit" : "generate";
}

function buildImagesRequest(prompt, args, config) {
  const action = resolveAction(args);
  const model = args["image-model"] || config.imageModel;
  if (!model) {
    die("no image model found. Set provider image_model or pass --image-model.");
  }

  // CUMOB returns a task object immediately when async=true. Keep this on
  // both JSON and multipart requests so image generation never blocks on POST.
  const fields = { model, prompt, async: true };
  const optionMap = {
    background: "background",
    "input-fidelity": "input_fidelity",
    moderation: "moderation",
    "output-compression": "output_compression",
    format: "output_format",
    quality: "quality",
    size: "size",
  };
  for (const [argName, fieldName] of Object.entries(optionMap)) {
    if (args[argName] !== undefined) fields[fieldName] = args[argName];
  }

  return {
    action,
    endpoint: `${config.baseUrl}/images/${action === "edit" ? "edits" : "generations"}`,
    fields,
  };
}

async function fetchImageBytes(result) {
  if (result.b64_json) return Buffer.from(result.b64_json, "base64");
  if (result.url) {
    const response = await fetch(result.url);
    if (!response.ok) {
      die(`failed to download generated image: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  die(`image result contained neither b64_json nor url: ${JSON.stringify(result).slice(0, 1000)}`);
}

async function writeImagesResults(responseJson, outputPath, outputFormat) {
  const results = Array.isArray(responseJson.data) ? responseJson.data : [];
  if (results.length === 0) {
    die(`Images API response contained no data: ${JSON.stringify(responseJson).slice(0, 1000)}`);
  }

  const written = [];
  for (let index = 0; index < results.length; index += 1) {
    const target = outputPathFor(outputPath, index, results.length, outputFormat);
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, await fetchImageBytes(results[index]));
    written.push(target);
  }
  return written;
}

function imageDataAvailable(responseJson) {
  return Array.isArray(responseJson?.data) && responseJson.data.length > 0 &&
    responseJson.data.some((item) => item?.url || item?.b64_json);
}

async function waitForImage(id, args, config, initial, outputPath, outputFormat, stateFile) {
  let current = initial;
  const started = Date.now();
  const timeoutMs = Number(args.timeout || 1800) * 1000;
  const configuredDelayMs = pollIntervalMs(args);
  let delayMs = configuredDelayMs;
  let retryAttempt = 0;
  while (true) {
    const status = String(current?.status || "").toLowerCase();
    if (status === "succeeded" && imageDataAvailable(current)) {
      writeTaskState(stateFile, { id, status, progress: current.progress ?? 100, created: current.created, model: current.model || config.imageModel, output: outputPath, updated_at: new Date().toISOString() });
      return current;
    }
    if (["failed", "cancelled", "canceled"].includes(status)) {
      die(`image task ${id} failed: ${apiErrorMessage(current)}`);
    }
    if (Date.now() - started > timeoutMs) {
      die(`timed out waiting for image task ${id}; use --resume ${id} to continue later.`);
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    progress(args, `Image task ${id}: ${status || "unknown"}${current?.progress !== undefined ? ` (${current.progress}%)` : ""}; waited ${elapsed}s.`);
    await sleep(delayMs);
    try {
      current = await requestJson(`${config.baseUrl}/status/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
      writeTaskState(stateFile, { id, status: current.status, progress: current.progress, created: current.created, model: current.model || config.imageModel, output: outputPath, updated_at: new Date().toISOString() });
      retryAttempt = 0;
      delayMs = configuredDelayMs;
      const retryAfter = Number(current?.retry_after || current?.retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) delayMs = retryAfter * 1000;
    } catch (error) {
      if (!transientError(error) || Date.now() - started > timeoutMs) {
        die(`temporary network error while polling image task ${id}: ${error.message || error}. The task may still be running; resume with --resume ${id}.`);
      }
      retryAttempt += 1;
      delayMs = Math.min(60000, 1000 * (2 ** Math.min(retryAttempt, 6)));
      progress(args, `Status check failed (${error instanceof HttpError ? `HTTP ${error.status}` : (error.message || "network error")}); retrying (${retryAttempt}) in ${Math.round(delayMs / 1000)}s. Task ${id} is not being recreated.`);
    }
  }
}

async function runImagesApi(prompt, args, config, outputPath) {
  const request = buildImagesRequest(prompt, args, config);
  if (request.action === "edit" && args.image.length === 0) {
    die("Images API edit mode requires at least one --image.");
  }
  if (request.action === "generate" && (args.image.length > 0 || args.mask)) {
    die("Images API generate mode does not accept --image or --mask. Use --action edit.");
  }

  const stateFile = taskStatePath(args, outputPath);
  const resumeState = args.resume ? (fs.existsSync(args.resume) ? readTaskState(path.resolve(args.resume)) : readTaskState(stateFile)) : null;
  const resumeId = resumeState?.id || args.resume;

  if (args["dry-run"]) {
    console.log(JSON.stringify({
      codex_home: config.codexHome,
      config_path: config.configPath,
      auth_path: config.authPath,
      provider: config.providerName,
      image_api: config.imageApi,
      base_url: config.baseUrl,
      endpoint: request.endpoint,
      image_model: request.fields.model,
      has_api_key: config.hasApiKey,
      api_key_source: config.apiKeySource,
      request: {
        ...request.fields,
        images: args.image.map((imagePath) => path.resolve(imagePath)),
        original_images: args.originalImages?.map((imagePath) => path.resolve(imagePath)),
        input_optimization: args.inputOptimization,
        mask: args.mask ? path.resolve(args.mask) : undefined,
        task_file: stateFile,
        resume_id: resumeId || null,
      },
    }, null, 2));
    return;
  }

  if (resumeId) {
    if (config.imageApi !== "images") die("--resume is only supported for CUMOB Images API tasks, not Responses API tasks.");
    const outputFormat = path.extname(outputPath).replace(".", "") || "png";
    progress(args, `Resuming existing image task ${resumeId}; no create request will be sent.`);
    const completed = await waitForImage(resumeId, args, config, { id: resumeId, status: "queued" }, outputPath, outputFormat, stateFile);
    const written = await writeImagesResults(completed, outputPath, outputFormat);
    if (args.json) console.log(JSON.stringify({ id: resumeId, status: completed.status, provider: config.providerName, image_api: config.imageApi, image_model: config.imageModel, outputs: written }, null, 2));
    else for (const filePath of written) console.log(`Wrote ${filePath}`);
    return;
  }

  let body;
  let headers = { Authorization: `Bearer ${config.apiKey}` };
  if (request.action === "generate") {
    headers = { ...headers, "Content-Type": "application/json" };
    body = JSON.stringify(request.fields);
  } else {
    const form = new FormData();
    for (const [key, value] of Object.entries(request.fields)) {
      form.append(key, String(value));
    }
    for (const imagePath of args.image) {
      if (!fs.existsSync(imagePath)) die(`image file not found: ${imagePath}`);
      const fieldName = args.image.length === 1 ? "image" : "image[]";
      form.append(
        fieldName,
        new Blob([fs.readFileSync(imagePath)], { type: mimeTypeFor(imagePath) }),
        path.basename(imagePath),
      );
    }
    if (args.mask) {
      if (!fs.existsSync(args.mask)) die(`mask file not found: ${args.mask}`);
      form.append(
        "mask",
        new Blob([fs.readFileSync(args.mask)], { type: mimeTypeFor(args.mask) }),
        path.basename(args.mask),
      );
    }
    body = form;
  }

  let response;
  let responseText;
  const stopProgress = startProgress(args);
  try {
    response = await fetch(request.endpoint, { method: "POST", headers, body });
    responseText = await response.text();
  } finally {
    stopProgress();
  }
  progress(args, "Response received. Decoding image task.");

  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    die(`API returned non-JSON response with status ${response.status}: ${responseText.slice(0, 500)}`);
  }
  if (!response.ok) {
    const message = responseJson.error?.message || responseJson.message || JSON.stringify(responseJson).slice(0, 1000);
    die(`API request failed with status ${response.status}: ${message}`);
  }

  const outputFormat = request.fields.output_format || path.extname(outputPath).replace(".", "") || "png";
  let completed = responseJson;
  const taskId = responseJson.id;
  if (!imageDataAvailable(responseJson) || String(responseJson.status || "").toLowerCase() !== "succeeded") {
    if (!taskId) die(`Images API response contained neither final data nor a task id: ${JSON.stringify(responseJson).slice(0, 1000)}`);
    writeTaskState(stateFile, { id: taskId, status: responseJson.status, progress: responseJson.progress, created: responseJson.created, model: request.fields.model, output: outputPath, updated_at: new Date().toISOString() });
    completed = await waitForImage(taskId, args, config, responseJson, outputPath, outputFormat, stateFile);
  }
  const written = await writeImagesResults(completed, outputPath, outputFormat);
  const summary = {
    provider: config.providerName,
    image_api: config.imageApi,
    base_url: config.baseUrl,
    image_model: request.fields.model,
    id: taskId || completed.id,
    outputs: written,
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const filePath of written) console.log(`Wrote ${filePath}`);
  }
}

async function main() {
  if (typeof fetch !== "function") {
    die("Node.js 18+ is required because this script uses the built-in fetch API.");
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP.trim());
    return;
  }

  const prompt = args.resume ? null : await readPrompt(args);
  const config = resolveCodexConfig(args);
  const outputPath = args.out || "generated.png";
  const cleanupOptimizedInputs = args.resume ? () => {} : optimizeInputImages(args);
  try {
    if (config.imageApi === "images") {
      await runImagesApi(prompt, args, config, outputPath);
      return;
    }
    const tool = buildTool(args);
    if (!tool.model && config.imageModel) tool.model = config.imageModel;
    const requestBody = {
      model: config.responseModel,
      input: buildInput(prompt, args),
      tools: [tool],
    };

    if (args["dry-run"]) {
      console.log(JSON.stringify({
        codex_home: config.codexHome,
        config_path: config.configPath,
        auth_path: config.authPath,
        provider: config.providerName,
        base_url: config.baseUrl,
        endpoint: `${config.baseUrl}/responses`,
        response_model: config.responseModel,
        has_api_key: config.hasApiKey,
        api_key_source: config.apiKeySource,
        original_images: args.originalImages?.map((imagePath) => path.resolve(imagePath)),
        input_optimization: args.inputOptimization,
        request: redactRequest(requestBody),
      }, null, 2));
      return;
    }

    let response;
    let responseText;
    const stopProgress = startProgress(args);
    try {
      response = await fetch(`${config.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      responseText = await response.text();
    } finally {
      stopProgress();
    }
    progress(args, "Response received. Decoding image data.");

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      die(`API returned non-JSON response with status ${response.status}: ${responseText.slice(0, 500)}`);
    }

    if (!response.ok) {
      const message = responseJson.error?.message || responseJson.message || JSON.stringify(responseJson).slice(0, 1000);
      die(`API request failed with status ${response.status}: ${message}`);
    }

    const imageResults = [];
    for (const item of responseJson.output || []) {
      if (item.type === "image_generation_call" && item.result) {
        imageResults.push(item.result);
      }
    }

    if (imageResults.length === 0) {
      console.error(JSON.stringify(summarizeResponse(responseJson), null, 2));
      die("response did not contain output[].type == image_generation_call with a result.");
    }

    const outputFormat = tool.output_format || path.extname(outputPath).replace(".", "") || "png";
    const written = [];
    for (let i = 0; i < imageResults.length; i += 1) {
      const target = outputPathFor(outputPath, i, imageResults.length, outputFormat);
      fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      fs.writeFileSync(target, Buffer.from(imageResults[i], "base64"));
      written.push(target);
    }

    const summary = {
      response_id: responseJson.id,
      provider: config.providerName,
      base_url: config.baseUrl,
      response_model: config.responseModel,
      image_model: tool.model || "api-default",
      outputs: written,
    };

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      for (const filePath of written) {
        console.log(`Wrote ${filePath}`);
      }
    }
  } finally {
    cleanupOptimizedInputs();
  }
}

main().catch((error) => {
  die(error.stack || error.message || String(error));
});
