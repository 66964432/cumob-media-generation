import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_POLL_INTERVAL_SECONDS = 30;

export function die(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

export function log(args, scope, message) {
  if (!args["no-progress"]) console.error(`[${scope}] ${message}`);
}

export function parseArgs(argv, { repeated = [], flags = [], valued = [] }) {
  const repeatSet = new Set(repeated);
  const flagSet = new Set(flags);
  const valueSet = new Set(valued);
  const args = Object.fromEntries(repeated.map((name) => [name, []]));
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) die(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (flagSet.has(name)) {
      args[name] = true;
      continue;
    }
    if (!repeatSet.has(name) && !valueSet.has(name)) die(`unknown option: --${name}`);
    const value = argv[++index];
    if (value === undefined) die(`--${name} requires a value`);
    if (repeatSet.has(name)) args[name].push(value);
    else args[name] = value;
  }
  return args;
}

export async function readPrompt(args) {
  if (args.prompt) return args.prompt;
  if (args["prompt-file"]) return fs.readFileSync(args["prompt-file"], "utf8").trim();
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const prompt = Buffer.concat(chunks).toString("utf8").trim();
    if (prompt) return prompt;
  }
  die("missing --prompt, --prompt-file, or stdin prompt");
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
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
    if (match) current[match[1]] = parseTomlValue(match[2].replace(/\s+#.*$/, ""));
  }
  return result;
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    die(`failed to parse ${file}: ${error.message}`);
  }
}

function env(name) {
  if (process.env[name] !== undefined) return process.env[name];
  const wanted = name.toLowerCase();
  return Object.entries(process.env).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

export function resolveConfig(args, kind) {
  const codexHome = path.resolve(args["codex-home"] || env("CODEX_HOME") || path.join(os.homedir(), ".codex"));
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const config = fs.existsSync(configPath) ? parseToml(fs.readFileSync(configPath, "utf8")) : { root: {}, sections: {} };
  const providerName = config.root.model_provider || "OpenAI";
  const provider = config.sections[`model_providers.${providerName}`] || {};
  const keyEnv = args["api-key-env"] || "OPENAI_API_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) die("--api-key-env must be an environment variable name");
  const auth = readJson(authPath);
  const apiKey = auth.OPENAI_API_KEY || env(keyEnv);
  if (!apiKey && !args["dry-run"]) die(`no API key found in ${authPath} or ${keyEnv}`);
  const defaultBase = "https://api.cumob.com/v1";
  const baseUrl = String(args["base-url"] || provider.base_url || env("OPENAI_BASE_URL") || defaultBase).replace(/\/+$/, "");
  const modelKey = kind === "image" ? "image_model" : "video_model";
  const envKey = kind === "image" ? "OPENAI_IMAGE_MODEL" : "OPENAI_VIDEO_MODEL";
  const fallbackModel = kind === "image" ? "gpt-image-2.5" : "minimax-h3";
  const model = args[`${kind}-model`] || provider[modelKey] || env(envKey) || fallbackModel;
  return { baseUrl, model, apiKey, hasApiKey: Boolean(apiKey) };
}

export function taskFile(args, output) {
  return path.resolve(args["task-file"] || `${output}.task.json`);
}

export function writeTask(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, file);
}

export function resumeId(args) {
  if (!args.resume) return null;
  if (!fs.existsSync(args.resume)) return args.resume;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(args.resume), "utf8")).id;
  } catch (error) {
    die(`failed to read resume file ${args.resume}: ${error.message}`);
  }
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function requestJson(url, options = {}, timeoutMs = 60000) {
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
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new HttpError(response.status, body);
  return body;
}

export function errorMessage(body) {
  const reason = body?.failure_reason;
  const detail = body?.error?.message || body?.error || body?.message;
  if (reason) return detail && detail !== "error" && detail !== reason ? `${reason}: ${detail}` : String(reason);
  return detail || JSON.stringify(body).slice(0, 1000);
}

function transient(error) {
  return !(error instanceof HttpError) || [408, 425, 429, 500, 502, 503, 504].includes(error.status);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pollIntervals(args, subsequentDefaultSeconds = DEFAULT_POLL_INTERVAL_SECONDS) {
  const override = args["poll-interval"];
  const firstSeconds = Math.max(1, Number(override || DEFAULT_POLL_INTERVAL_SECONDS));
  const subsequentSeconds = Math.max(1, Number(override || subsequentDefaultSeconds));
  return { first: firstSeconds * 1000, subsequent: subsequentSeconds * 1000 };
}

export async function pollTask({ id, args, scope, statusUrl, headers, output, model, initial, completed, subsequentPollIntervalSeconds }) {
  const file = taskFile(args, output);
  const intervals = pollIntervals(args, subsequentPollIntervalSeconds);
  const timeout = Math.max(1, Number(args.timeout || 1800)) * 1000;
  const started = Date.now();
  let current = initial || { id, status: "queued" };
  let delay = intervals.first;
  let failures = 0;
  while (true) {
    const status = String(current?.status || "").toLowerCase();
    if (completed(current)) return current;
    if (["failed", "cancelled", "canceled"].includes(status)) {
      const failure = errorMessage(current);
      writeTask(file, {
        id,
        status,
        model,
        output,
        failure_reason: current?.failure_reason,
        error: current?.error,
        updated_at: new Date().toISOString(),
      });
      die(`${scope} task ${id} failed: ${failure}`);
    }
    if (Date.now() - started > timeout) die(`timed out waiting for ${scope} task ${id}; resume with --resume ${id}`);
    log(args, scope, `task ${id}: ${status || "unknown"}${current.progress !== undefined ? ` (${current.progress}%)` : ""}`);
    await sleep(delay);
    try {
      current = await requestJson(`${statusUrl}/${encodeURIComponent(id)}`, { headers });
      writeTask(file, { id, status: current.status, progress: current.progress, model, output, updated_at: new Date().toISOString() });
      failures = 0;
      const retryAfter = Number(current.retry_after || current.retryAfter);
      delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : intervals.subsequent;
    } catch (error) {
      if (!transient(error)) die(`${scope} status request failed: ${errorMessage(error.body || error)}`);
      failures += 1;
      delay = Math.min(10000, 1000 * (2 ** Math.min(failures, 4)));
      log(args, scope, `status check failed; retrying in ${Math.round(delay / 1000)}s without recreating the task`);
    }
  }
}

export function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
  })[ext] || "application/octet-stream";
}

export function appendFile(form, field, file) {
  if (!fs.existsSync(file)) die(`file not found: ${file}`);
  form.append(field, new Blob([fs.readFileSync(file)], { type: mimeType(file) }), path.basename(file));
}

function numberOption(args, name, fallback, min, max) {
  const value = args[name] === undefined ? fallback : Number(args[name]);
  if (!Number.isFinite(value) || value < min || value > max) die(`--${name} must be between ${min} and ${max}`);
  return value;
}

function inputOptimizer() {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sips")) return { name: "sips", command: "/usr/bin/sips" };
  const result = spawnSync("magick", ["-version"], { stdio: "ignore" });
  return result.status === 0 ? { name: "magick", command: "magick" } : null;
}

function hasAlpha(file, optimizer) {
  const result = optimizer.name === "sips"
    ? spawnSync(optimizer.command, ["-g", "hasAlpha", file], { encoding: "utf8" })
    : spawnSync(optimizer.command, ["identify", "-format", "%[channels]", file], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return optimizer.name === "sips" ? /hasAlpha:\s*(yes|true)/i.test(result.stdout) : /a/i.test(result.stdout);
}

export function optimizeImages(files, args, scope) {
  const details = [];
  if (!files.length || args["no-input-optimization"]) return { files, details, cleanup: () => {} };
  const threshold = numberOption(args, "input-optimize-threshold-mb", 4, 0, 1024) * 1024 * 1024;
  const oversized = files.filter((file) => {
    if (!fs.existsSync(file)) die(`image file not found: ${file}`);
    return fs.statSync(file).size > threshold;
  });
  if (!oversized.length || args["dry-run"]) {
    for (const file of files) details.push({ original: path.resolve(file), optimized: false, reason: args["dry-run"] && oversized.includes(file) ? "dry-run" : "below-threshold" });
    return { files, details, cleanup: () => {} };
  }
  const optimizer = inputOptimizer();
  if (!optimizer) return { files, details: files.map((file) => ({ original: path.resolve(file), optimized: false, reason: "optimizer-unavailable" })), cleanup: () => {} };
  const maxDimension = Math.round(numberOption(args, "max-input-dimension", 1536, 256, 8192));
  const jpegQuality = Math.round(numberOption(args, "input-jpeg-quality", 85, 1, 100));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cumob-input-"));
  const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true });
  process.once("exit", cleanup);
  const optimized = files.map((file, index) => {
    const size = fs.statSync(file).size;
    if (size <= threshold) {
      details.push({ original: path.resolve(file), optimized: false, reason: "below-threshold" });
      return file;
    }
    const alpha = hasAlpha(file, optimizer);
    const target = path.join(tempDir, `input-${index + 1}.${alpha ? "png" : "jpg"}`);
    const command = optimizer.name === "sips"
      ? ["-Z", String(maxDimension), "-s", "format", alpha ? "png" : "jpeg", ...(alpha ? [] : ["-s", "formatOptions", String(jpegQuality)]), file, "--out", target]
      : [file, "-auto-orient", "-resize", `${maxDimension}x${maxDimension}>`, ...(alpha ? [] : ["-quality", String(jpegQuality)]), target];
    const result = spawnSync(optimizer.command, command, { encoding: "utf8" });
    if (result.status !== 0 || !fs.existsSync(target) || fs.statSync(target).size >= size) {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      details.push({ original: path.resolve(file), optimized: false, reason: "no-size-benefit" });
      return file;
    }
    log(args, scope, `optimized reference image ${path.basename(file)}: ${Math.round(size / 1024)}KB -> ${Math.round(fs.statSync(target).size / 1024)}KB`);
    details.push({ original: path.resolve(file), optimized: true, path: target });
    return target;
  });
  return { files: optimized, details, cleanup };
}


export function normalizeImageSize(file, requestedSize, args) {
  const match = /^(\d+)x(\d+)$/.exec(String(requestedSize || ""));
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const optimizer = inputOptimizer();
  if (!optimizer) return false;
  let currentWidth;
  let currentHeight;
  if (optimizer.name === "sips") {
    const info = spawnSync(optimizer.command, ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
    currentWidth = Number(/pixelWidth:\s*(\d+)/.exec(info.stdout)?.[1]);
    currentHeight = Number(/pixelHeight:\s*(\d+)/.exec(info.stdout)?.[1]);
  } else {
    const info = spawnSync(optimizer.command, ["identify", "-format", "%w %h", file], { encoding: "utf8" });
    [currentWidth, currentHeight] = info.stdout.trim().split(/\s+/).map(Number);
  }
  if (currentWidth === width && currentHeight === height) return false;
  const extension = path.extname(file) || ".png";
  const temp = `${file}.resize-${process.pid}${extension}`;
  const command = optimizer.name === "sips"
    ? ["-z", String(height), String(width), file, "--out", temp]
    : [file, "-resize", `${width}x${height}!`, temp];
  const result = spawnSync(optimizer.command, command, { encoding: "utf8" });
  if (result.status !== 0 || !fs.existsSync(temp)) {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    return false;
  }
  fs.renameSync(temp, file);
  log(args, "image-generation", `normalized output to ${width}x${height}`);
  return true;
}

export async function download(url, output, apiKey) {
  const hostname = new URL(url).hostname.toLowerCase();
  const auth = hostname === "cumob.com" || hostname.endsWith(".cumob.com") ? { Authorization: `Bearer ${apiKey}` } : {};
  const response = await fetch(url, { headers: auth });
  if (!response.ok || !response.body) die(`download failed: HTTP ${response.status}`);
  const absolute = path.resolve(output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.part-${process.pid}`;
  const stream = fs.createWriteStream(temp);
  try {
    for await (const chunk of response.body) stream.write(Buffer.from(chunk));
  } finally {
    await new Promise((resolve) => stream.end(resolve));
  }
  if (!fs.statSync(temp).size) die("downloaded file is empty");
  fs.renameSync(temp, absolute);
  return output;
}
