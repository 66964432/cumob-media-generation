#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { errorMessage, pollIntervals } from "../scripts/media-common.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cumob-media-test-"));
fs.writeFileSync(path.join(temp, "config.toml"), [
  'model_provider = "test"',
  '[model_providers.test]',
  'base_url = "https://example.test/v1"',
  'image_model = "gpt-image-test"',
  'video_model = "minimax-h3"',
].join("\n"));
fs.writeFileSync(path.join(temp, "reference.png"), Buffer.from("local-reference"));

function dryRun(script, args) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), "--codex-home", temp, "--dry-run", "--no-progress", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  assert.equal(
    errorMessage({ error: "error", failure_reason: "reference_image_download_failed", status: "failed" }),
    "reference_image_download_failed",
  );
  assert.equal(
    errorMessage({ error: { message: "remote returned 403" }, failure_reason: "reference_image_download_failed" }),
    "reference_image_download_failed: remote returned 403",
  );
  assert.deepEqual(pollIntervals({}, 15), { first: 30000, subsequent: 15000 });
  assert.deepEqual(pollIntervals({}, 30), { first: 30000, subsequent: 30000 });
  assert.deepEqual(pollIntervals({ "poll-interval": "1" }, 15), { first: 1000, subsequent: 1000 });

  const image = dryRun("generate-image.mjs", ["--prompt", "test", "--out", "test.png", "--size", "1024x1024"]);
  assert.equal(image.endpoint, "https://example.test/v1/images/generations");
  assert.equal(image.model, "gpt-image-test");
  assert.equal(image.fields.async, true);
  assert.equal(image.fields.size, "1024x1024");

  const imageUrl = dryRun("generate-image.mjs", [
    "--prompt", "use reference", "--image-url", "https://example.test/reference.png", "--out", "reference.png",
  ]);
  assert.equal(imageUrl.endpoint, "https://example.test/v1/images/generations");
  assert.deepEqual(imageUrl.fields.images, ["https://example.test/reference.png"]);
  assert.deepEqual(imageUrl.images, []);
  assert.deepEqual(imageUrl.input_optimization, []);

  const mixedImage = dryRun("generate-image.mjs", [
    "--prompt", "use references",
    "--image", path.join(temp, "reference.png"),
    "--image-url", "https://example.test/reference.png",
    "--out", "mixed.png",
  ]);
  assert.equal(mixedImage.endpoint, "https://example.test/v1/images/generations");
  assert.equal(mixedImage.transport, "multipart/form-data");
  assert.deepEqual(mixedImage.fields.images, ["https://example.test/reference.png"]);
  assert.deepEqual(mixedImage.images, [path.join(temp, "reference.png")]);

  const video = dryRun("generate-video.mjs", [
    "--prompt", "test", "--video-model", "minimax-h3-2k", "--duration", "20",
    "--image-url", "https://example.test/reference.png", "--audio-url", "https://example.test/audio.mp3",
  ]);
  assert.equal(video.endpoint, "https://example.test/v1/videos");
  assert.equal(video.request.model, "minimax-h3-2k");
  assert.equal(video.request.duration, 15);
  assert.equal(video.effective_resolution, "1440p");
  assert.equal("resolution" in video.request, false);
  assert.deepEqual(video.references, { images: 1, videos: 0, audios: 1 });

  const rejected = spawnSync(process.execPath, [path.join(root, "scripts/generate-video.mjs"), "--codex-home", temp, "--dry-run", "--no-progress", "--prompt", "test", "--video-model", "minimax-h3-2k", "--video-url", "https://example.test/video.mp4"], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not support video references/);

  const vendorRegistry = JSON.parse(fs.readFileSync(path.join(root, "vendor-skills/registry.json"), "utf8"));
  const vendor = vendorRegistry.vendors["minimax-h3"];
  for (const [relative, expected] of Object.entries(vendor.files)) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, vendor.source_root, relative))).digest("hex");
    assert.equal(actual, expected, `official vendor file changed: ${relative}`);
  }

  console.log("media tests passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
