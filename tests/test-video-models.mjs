#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cumob-video-model-tests-"));
fs.writeFileSync(path.join(temp, "config.toml"), [
  'model_provider = "test"',
  '[model_providers.test]',
  'base_url = "https://example.test/v1"',
  'video_model = "minimax-h3-ref"',
  "",
].join("\n"));

const runtimes = [
  { name: "node", command: process.execPath, script: path.join(root, "scripts/generate-video.mjs") },
  { name: "python", command: "python3", script: path.join(root, "scripts/generate-video.py") },
];

function run(runtime, args, expectedStatus = 0) {
  const result = spawnSync(runtime.command, [runtime.script, "--codex-home", temp, "--no-progress", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, expectedStatus, `${runtime.name} exited ${result.status}: ${result.stderr}`);
  return result;
}

function dryRun(runtime, args) {
  const result = run(runtime, [...args, "--dry-run"]);
  return JSON.parse(result.stdout);
}

function runFailure(runtime, args) {
  const result = spawnSync(runtime.command, [runtime.script, "--codex-home", temp, "--no-progress", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, `${runtime.name} unexpectedly succeeded`);
  return result;
}

try {
  for (const runtime of runtimes) {
    const h3 = dryRun(runtime, [
      "--prompt", "test", "--video-model", "minimax-h3-ref", "--duration", "9",
      "--resolution", "1440p", "--video-url", "https://example.test/video.mp4",
      "--audio-url", "https://example.test/audio.mp3", "--generate-audio", "true",
      "--metadata-json", '{"job":"test"}',
    ]);
    assert.equal(h3.request.duration, 10);
    assert.equal(h3.effective_resolution, "768p");
    assert.equal(h3.resolution_sent, false);
    assert.equal("resolution" in h3.request, false);
    assert.deepEqual(h3.request.videos, ["https://example.test/video.mp4"]);
    assert.deepEqual(h3.request.audios, ["https://example.test/audio.mp3"]);
    assert.deepEqual(h3.request.metadata, { job: "test" });
    assert.equal(h3.request.generate_audio, true);

    const h3_2k = dryRun(runtime, [
      "--prompt", "test", "--video-model", "minimax-h3-2k-ref", "--duration", "16",
      "--resolution", "768p", "--image-url", "https://example.test/image.png",
      "--audio-url", "https://example.test/audio.mp3",
    ]);
    assert.equal(h3_2k.request.duration, 15);
    assert.equal(h3_2k.effective_resolution, "1440p");
    assert.equal(h3_2k.resolution_sent, false);
    assert.equal("resolution" in h3_2k.request, false);
    assert.deepEqual(h3_2k.request.images, ["https://example.test/image.png"]);
    assert.deepEqual(h3_2k.request.audios, ["https://example.test/audio.mp3"]);

    const exactLimit = ["--prompt", "test", "--video-model", "minimax-h3-2k-ref"];
    for (let index = 0; index < 9; index += 1) exactLimit.push("--image-url", `https://example.test/image-${index}.png`);
    for (let index = 0; index < 3; index += 1) exactLimit.push("--audio-url", `https://example.test/audio-${index}.mp3`);
    const exactLimitResult = dryRun(runtime, exactLimit);
    assert.equal(exactLimitResult.request.duration, 10);
    assert.equal(exactLimitResult.request.images.length + exactLimitResult.request.audios.length, 12);

    const unsupportedVideo = runFailure(runtime, [
      "--prompt", "test", "--video-model", "minimax-h3-2k-ref",
      "--video-url", "https://example.test/video.mp4", "--dry-run",
    ]);
    assert.match(unsupportedVideo.stderr, /does not support video references/);

    const unsupportedParameter = runFailure(runtime, [
      "--prompt", "test", "--video-model", "minimax-h3-ref",
      "--negative-prompt", "blur", "--dry-run",
    ]);
    assert.match(unsupportedParameter.stderr, /unsupported option|unrecognized arguments/);

    const tooManyReferences = ["--prompt", "test", "--video-model", "minimax-h3-ref"];
    for (let index = 0; index < 9; index += 1) tooManyReferences.push("--image-url", `https://example.test/image-${index}.png`);
    for (let index = 0; index < 3; index += 1) tooManyReferences.push("--video-url", `https://example.test/video-${index}.mp4`);
    tooManyReferences.push("--audio-url", "https://example.test/audio.mp3", "--dry-run");
    const overLimit = run(runtime, tooManyReferences, 1);
    assert.match(overLimit.stderr, /combined must not exceed 12/);
  }

  console.log("video model contract tests passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
