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

// ── Claude Code style settings.json for testing ──
const claudeTemp = fs.mkdtempSync(path.join(os.tmpdir(), "cumob-claude-test-"));
const claudeHome = path.join(claudeTemp, ".claude");
fs.mkdirSync(claudeHome, { recursive: true });
fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({
  env: {
    CUMOB_API_KEY: "claude-test-key",
    CUMOB_BASE_URL: "https://claude-example.test/v1",
    CUMOB_IMAGE_MODEL: "claude-image-model",
    CUMOB_VIDEO_MODEL: "claude-video-model",
  }
}, null, 2));

function dryRun(script, args) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), "--codex-home", temp, "--dry-run", "--no-progress", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function dryRunWithEnv(script, args, env) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), "--dry-run", "--no-progress", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env, HOME: claudeTemp },
  });
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

  const fhdVideo = dryRun("generate-video.mjs", [
    "--prompt", "test", "--video-model", "minimax-h3-fhd", "--duration", "20",
    "--aspect-ratio", "9:16", "--image-url", "https://example.test/reference.png",
    "--audio-url", "https://example.test/audio.mp3",
  ]);
  assert.equal(fhdVideo.endpoint, "https://example.test/v1/videos");
  assert.equal(fhdVideo.request.model, "minimax-h3-fhd");
  assert.equal(fhdVideo.request.duration, 15);
  assert.equal(fhdVideo.request.aspect_ratio, "9:16");
  assert.equal(fhdVideo.effective_resolution, "1080p");
  assert.equal("resolution" in fhdVideo.request, false);
  assert.deepEqual(fhdVideo.references, { images: 1, videos: 0, audios: 1 });

  const fhdInvalidResolution = spawnSync(process.execPath, [path.join(root, "scripts", "generate-video.mjs"), "--codex-home", temp, "--dry-run", "--no-progress", "--prompt", "test", "--video-model", "minimax-h3-fhd", "--resolution", "1440p"], { encoding: "utf8" });
  assert.notEqual(fhdInvalidResolution.status, 0);
  assert.match(fhdInvalidResolution.stderr, /unsupported resolution for minimax-h3-fhd: 1440p/);

  const rejected = spawnSync(process.execPath, [path.join(root, "scripts/generate-video.mjs"), "--codex-home", temp, "--dry-run", "--no-progress", "--prompt", "test", "--video-model", "minimax-h3-2k", "--video-url", "https://example.test/video.mp4"], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not support video references/);

  const vendorRegistry = JSON.parse(fs.readFileSync(path.join(root, "vendor-skills/registry.json"), "utf8"));
  const vendor = vendorRegistry.vendors["minimax-h3"];
  for (const [relative, expected] of Object.entries(vendor.files)) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, vendor.source_root, relative))).digest("hex");
    assert.equal(actual, expected, `official vendor file changed: ${relative}`);
  }

  // ── CUMOB_* environment variable priority tests ──
  const cumobEnvImage = dryRunWithEnv("generate-image.mjs", [
    "--prompt", "env-test", "--out", "env-test.png",
  ], {
    CUMOB_API_KEY: "cumob-key-from-env",
    CUMOB_BASE_URL: "https://cumob-env.test/v1",
    CUMOB_IMAGE_MODEL: "cumob-env-image-model",
    CODEX_HOME: temp,
  });
  assert.equal(cumobEnvImage.endpoint, "https://cumob-env.test/v1/images/generations", "CUMOB_BASE_URL should override Codex config");
  assert.equal(cumobEnvImage.model, "cumob-env-image-model", "CUMOB_IMAGE_MODEL should override Codex config");
  assert.equal(cumobEnvImage.has_api_key, true, "CUMOB_API_KEY should provide API key");

  const cumobEnvVideo = dryRunWithEnv("generate-video.mjs", [
    "--prompt", "env-test", "--out", "env-test.mp4",
  ], {
    CUMOB_API_KEY: "cumob-key-from-env",
    CUMOB_BASE_URL: "https://cumob-env.test/v1",
    CUMOB_VIDEO_MODEL: "minimax-h3",
    CODEX_HOME: temp,
  });
  assert.equal(cumobEnvVideo.endpoint, "https://cumob-env.test/v1/videos", "CUMOB_BASE_URL should override Codex config for video");
  assert.equal(cumobEnvVideo.request.model, "minimax-h3", "CUMOB_VIDEO_MODEL should be used");

  // ── Claude Code settings.json fallback test ──
  // When no --codex-home and no CODEX_HOME, and HOME points to claudeTemp,
  // the script should fall back to reading Claude Code settings.json
  const claudeImage = dryRunWithEnv("generate-image.mjs", [
    "--prompt", "claude-test", "--out", "claude-test.png",
  ], {
    // No CUMOB_* env, no CODEX_HOME, no OPENAI_* — force Claude Code fallback
    HOME: claudeTemp,
  });
  assert.equal(claudeImage.endpoint, "https://claude-example.test/v1/images/generations", "Should read base URL from Claude Code settings.json");
  assert.equal(claudeImage.model, "claude-image-model", "Should read image model from Claude Code settings.json");
  assert.equal(claudeImage.has_api_key, true, "Should read API key from Claude Code settings.json");

  console.log("media tests passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(claudeTemp, { recursive: true, force: true });
}
