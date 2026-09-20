#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cumob-video-prompt-tests-"));
fs.writeFileSync(path.join(temp, "config.toml"), [
  'model_provider = "test"',
  '[model_providers.test]',
  'base_url = "https://example.test/v1"',
  'video_model = "minimax-h3"',
  "",
].join("\n"));

const runtimes = [
  { name: "node", command: process.execPath, script: path.join(root, "scripts/generate-video.mjs") },
  { name: "python", command: "python3", script: path.join(root, "scripts/generate-video.py") },
];

const basePrompt = [
  "integrated_multimodal_description: [Shot 1] <Picture 1> anchors the opening frame. [Shot 2] At 00:05.000, the camera cuts closer.",
  "overall_soundscape: Quiet room ambience and soft footsteps.",
  "non_diegetic_music: None.",
].join("\n");

const refPrompt = [
  "subject_definitions: <Subject 1> is the person shown in <Picture 1>.",
  "summary: A concise portrait sequence.",
  "retention_analysis: <Subject 1> is fully preserved.",
  "detailed_description: [Shot 1] <Subject 1> looks into camera. [Shot 2] At 00:06.000, <Audio 1> becomes audible.",
  "overall_soundscape: <Audio 1> provides the room ambience.",
  "non_diegetic_music: None.",
].join("\n");

function run(runtime, args, expectedStatus = 0) {
  const result = spawnSync(runtime.command, [runtime.script, "--codex-home", temp, "--no-progress", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, expectedStatus, `${runtime.name} exited ${result.status}: ${result.stderr}`);
  return result;
}

function dryRun(runtime, args) {
  return JSON.parse(run(runtime, [...args, "--dry-run"]).stdout);
}

function fail(runtime, args, pattern) {
  const result = spawnSync(runtime.command, [runtime.script, "--codex-home", temp, "--no-progress", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, `${runtime.name} unexpectedly succeeded`);
  assert.match(result.stderr, pattern);
}

try {
  const promptFile = path.join(temp, "h3.prompt.txt");
  fs.writeFileSync(promptFile, basePrompt);
  for (const runtime of runtimes) {
    const base = dryRun(runtime, [
      "--prompt-file", promptFile,
      "--prompt-mode", "I2VA",
      "--prompt-source", "codex-current-model",
      "--video-model", "minimax-h3",
      "--duration", "10",
      "--image-url", "https://example.test/image.png",
    ]);
    assert.equal(base.prompt_validation.format, "h3-base");
    assert.equal(base.prompt_validation.prompt_mode, "I2VA");
    assert.equal(base.prompt_validation.prompt_source, "codex-current-model");
    assert.equal(base.prompt_validation.label_style, "official");
    assert.equal(base.prompt_validation.prompt_skill.name, "h3-prompt-writing");
    assert.equal(base.prompt_validation.prompt_skill.optimizer, "codex-current-model");
    assert.equal(base.prompt_validation.prompt_skill.external_prompt_api, false);
    assert.equal(fs.realpathSync(base.prompt_file), fs.realpathSync(promptFile));

    const ref = dryRun(runtime, [
      "--prompt", refPrompt,
      "--prompt-mode", "Ref2VA",
      "--prompt-source", "codex-current-model",
      "--video-model", "minimax-h3-2k",
      "--duration", "10",
      "--image-url", "https://example.test/image.png",
      "--audio-url", "https://example.test/audio.mp3",
    ]);
    assert.equal(ref.prompt_validation.format, "h3-ref");
    assert.equal(ref.prompt_validation.referenced_media.images, 1);
    assert.equal(ref.prompt_validation.referenced_media.audios, 1);

    fail(runtime, [
      "--prompt", `${basePrompt}\n@图片1`,
      "--image-url", "https://example.test/image.png",
      "--prompt-mode", "I2VA",
      "--dry-run",
    ], /mixes legacy/);

    fail(runtime, [
      "--prompt", basePrompt.replace("<Picture 1>", "<Picture 2>"),
      "--image-url", "https://example.test/image.png",
      "--prompt-mode", "I2VA",
      "--dry-run",
    ], /only 1 were provided/);

    fail(runtime, [
      "--prompt", basePrompt.replace("<Picture 1>", "<Video 1>"),
      "--video-model", "minimax-h3-2k",
      "--video-url", "https://example.test/video.mp4",
      "--prompt-mode", "I2VA",
      "--dry-run",
    ], /does not support video references/);

    fail(runtime, [
      "--prompt", basePrompt.replace("00:05.000", "00:11.000"),
      "--image-url", "https://example.test/image.png",
      "--duration", "10",
      "--prompt-mode", "I2VA",
      "--dry-run",
    ], /exceeds the effective video duration/);

    fail(runtime, [
      "--prompt", "integrated_multimodal_description: [Shot 1] Test.",
      "--prompt-mode", "T2VA",
      "--dry-run",
    ], /missing required field/);
  }

  const vendorRegistry = JSON.parse(fs.readFileSync(path.join(root, "vendor-skills/registry.json"), "utf8"));
  const vendor = vendorRegistry.vendors["minimax-h3"];
  for (const [relative, expected] of Object.entries(vendor.files)) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, vendor.source_root, relative))).digest("hex");
    assert.equal(actual, expected, `official vendor file changed: ${relative}`);
  }

  console.log("video prompt integration tests passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
