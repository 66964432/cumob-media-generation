#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  appendFile,
  die,
  errorMessage,
  normalizeImageSize,
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
Usage: node scripts/generate-image.mjs --prompt "..." [options]

Core:
  --out <path>                  Default: generated.png
  --image <path>                Local edit/reference image; repeatable
  --image-url <url>             Remote reference image; repeatable and sent as-is
  --mask <path>                 Optional mask; requires local --image
  --image-model <model>         Default: configured image_model or gpt-image-2.5
  --size <size>                 Example: 1024x1024
  --quality <value>             low, medium, high, or auto
  --format <value>              png, webp, or jpeg
  --background <value>          transparent, opaque, or auto
  --input-fidelity <value>      high or low

Input optimization:
  --max-input-dimension <px>    Default: 1536
  --input-jpeg-quality <1-100>  Default: 85
  --input-optimize-threshold-mb <mb>  Default: 4
  --no-input-optimization

Task:
  --resume <id-or-task-file>
  --task-file <path>
  --poll-interval <seconds>     Override all polls. Default: first 30, then every 15
  --timeout <seconds>           Default: 1800
  --dry-run
  --json
  --no-progress
`;

const args = parseArgs(process.argv.slice(2), {
  repeated: ["image", "image-url"],
  flags: ["help", "dry-run", "json", "no-progress", "no-input-optimization"],
  valued: [
    "prompt", "prompt-file", "out", "mask", "image-model", "size", "quality", "format", "background",
    "input-fidelity", "output-compression", "codex-home", "base-url", "api-key-env", "resume", "task-file",
    "poll-interval", "timeout", "max-input-dimension", "input-jpeg-quality", "input-optimize-threshold-mb",
  ],
});

if (args.help) {
  console.log(HELP.trim());
  process.exit(0);
}
if (typeof fetch !== "function") die("Node.js 18+ is required");

const output = args.out || "generated.png";
const config = resolveConfig(args, "image");
const stateFile = taskFile(args, output);
const existingId = resumeId(args);
const optimized = existingId ? { files: [], details: [], cleanup: () => {} } : optimizeImages(args.image, args, "image-generation");
args.image = optimized.files;

function hasImageData(task) {
  return Array.isArray(task?.data) && task.data.some((item) => item?.url || item?.b64_json);
}

function targetPath(index, count, format) {
  if (count === 1) return output;
  const parsed = path.parse(output);
  return path.join(parsed.dir, `${parsed.name}-${index + 1}${parsed.ext || `.${format}`}`);
}

async function saveImages(task, format) {
  if (!hasImageData(task)) die(`image task returned no image data: ${errorMessage(task)}`);
  const files = [];
  for (let index = 0; index < task.data.length; index += 1) {
    const item = task.data[index];
    const target = targetPath(index, task.data.length, format);
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    if (item.b64_json) fs.writeFileSync(target, Buffer.from(item.b64_json, "base64"));
    else {
      const response = await fetch(item.url);
      if (!response.ok) die(`image download failed: HTTP ${response.status}`);
      fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    }
    files.push(target);
  }
  return files;
}

async function main() {
  try {
    const headers = { Authorization: `Bearer ${config.apiKey}` };
    for (const url of args["image-url"]) {
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      } catch {
        die(`invalid --image-url: ${url}`);
      }
    }
    let task;
    let format = args.format || path.extname(output).slice(1) || "png";

    if (existingId) {
      task = await pollTask({
        id: existingId,
        args,
        scope: "image-generation",
        statusUrl: `${config.baseUrl}/status`,
        headers,
        output,
        model: config.model,
        completed: (value) => String(value?.status).toLowerCase() === "succeeded" && hasImageData(value),
        subsequentPollIntervalSeconds: 15,
      });
    } else {
      const prompt = await readPrompt(args);
      const hasLocalImages = args.image.length > 0;
      const hasImageUrls = args["image-url"].length > 0;
      const maskedEdit = Boolean(args.mask);
      if (maskedEdit && !hasLocalImages) die("--mask requires --image");
      if (maskedEdit && hasImageUrls) die("--mask cannot be combined with --image-url");
      const endpoint = `${config.baseUrl}/images/${maskedEdit ? "edits" : "generations"}`;
      const fields = { model: config.model, prompt, async: true };
      if (hasImageUrls) fields.images = args["image-url"];
      for (const [option, field] of Object.entries({
        size: "size", quality: "quality", format: "output_format", background: "background",
        "input-fidelity": "input_fidelity", "output-compression": "output_compression",
      })) if (args[option] !== undefined) fields[field] = args[option];

      if (args["dry-run"]) {
        console.log(JSON.stringify({
          endpoint,
          model: config.model,
          action: maskedEdit ? "masked-edit" : hasLocalImages || hasImageUrls ? "reference" : "generate",
          transport: hasLocalImages || maskedEdit ? "multipart/form-data" : "application/json",
          fields,
          images: args.image.map((file) => path.resolve(file)),
          image_urls: args["image-url"],
          mask: args.mask ? path.resolve(args.mask) : null,
          input_optimization: optimized.details,
          has_api_key: config.hasApiKey,
          task_file: stateFile,
        }, null, 2));
        return;
      }

      let options;
      if (hasLocalImages || maskedEdit) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
          if (key !== "images") form.append(key, String(value));
        }
        if (maskedEdit) {
          for (const file of args.image) appendFile(form, args.image.length === 1 ? "image" : "image[]", file);
          appendFile(form, "mask", args.mask);
        } else {
          for (const url of args["image-url"]) form.append("images", url);
          for (const file of args.image) appendFile(form, "images", file);
        }
        options = { method: "POST", headers, body: form };
      } else {
        options = { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(fields) };
      }

      try {
        task = await requestJson(endpoint, options);
      } catch (error) {
        die(`image create request failed: ${errorMessage(error.body || error)}`);
      }
      const id = task.id;
      if (!hasImageData(task) && !id) die("image API returned neither image data nor a task id");
      if (id) writeTask(stateFile, { id, status: task.status, model: config.model, output, updated_at: new Date().toISOString() });
      if (!hasImageData(task)) {
        task = await pollTask({
          id,
          args,
          scope: "image-generation",
          statusUrl: `${config.baseUrl}/status`,
          headers,
          output,
          model: config.model,
          initial: task,
          completed: (value) => String(value?.status).toLowerCase() === "succeeded" && hasImageData(value),
          subsequentPollIntervalSeconds: 15,
        });
      }
      format = fields.output_format || format;
    }

    const files = await saveImages(task, format);
    for (const file of files) normalizeImageSize(file, args.size, args);
    const summary = { id: task.id || existingId, model: config.model, outputs: files };
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else files.forEach((file) => console.log(`Wrote ${file}`));
  } finally {
    optimized.cleanup();
  }
}

main().catch((error) => die(error.stack || error.message || String(error)));
