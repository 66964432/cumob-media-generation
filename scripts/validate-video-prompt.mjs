#!/usr/bin/env node

import fs from "node:fs";
import { validateVideoPrompt } from "./video-prompt-validation.mjs";

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  const valued = new Set(["prompt", "prompt-file", "video-model", "duration", "image-count", "video-count", "audio-count", "prompt-mode", "prompt-source"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) die(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!valued.has(key)) die(`unsupported option: --${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) die(`missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const prompt = args.prompt ?? (args["prompt-file"] ? fs.readFileSync(args["prompt-file"], "utf8") : !process.stdin.isTTY ? fs.readFileSync(0, "utf8") : "");
try {
  const result = validateVideoPrompt({
    prompt,
    model: args["video-model"] || "minimax-h3",
    duration: Number(args.duration || 10),
    imageCount: Number(args["image-count"] || 0),
    videoCount: Number(args["video-count"] || 0),
    audioCount: Number(args["audio-count"] || 0),
    promptMode: args["prompt-mode"],
    promptSource: args["prompt-source"] || "user",
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  die(error.message || String(error));
}
