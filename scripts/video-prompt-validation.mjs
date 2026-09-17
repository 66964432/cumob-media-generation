import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_FIELDS = [
  "integrated_multimodal_description",
  "overall_soundscape",
  "non_diegetic_music",
];

const REF_FIELDS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
];

const PROMPT_MODES = new Set(["T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"]);

export function defaultVideoRegistryPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../video-models.json");
}

export function loadVideoRegistry(registryPath = defaultVideoRegistryPath()) {
  return JSON.parse(fs.readFileSync(registryPath, "utf8"));
}

export function resolvePromptSkill(registry, model) {
  const skillId = registry.models?.[model]?.prompt_skill;
  if (!skillId) return null;
  const skill = registry.prompt_skills?.[skillId];
  if (!skill) throw new Error(`${model} references unknown prompt skill ${skillId}.`);
  return { id: skillId, ...skill };
}

function fieldPosition(prompt, field) {
  const match = new RegExp(`(?:^|\\n)\\s*${field}\\s*:`, "i").exec(prompt);
  return match ? match.index : -1;
}

function validateFieldStructure(prompt, fields, format) {
  const positions = fields.map((field) => fieldPosition(prompt, field));
  const missing = fields.filter((_, index) => positions[index] < 0);
  if (missing.length) throw new Error(`${format} prompt is missing required field(s): ${missing.join(", ")}.`);
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] <= positions[index - 1]) {
      throw new Error(`${format} prompt fields must appear in this order: ${fields.join(", ")}.`);
    }
  }
}

function collectLabels(prompt, pattern, type) {
  return [...prompt.matchAll(pattern)].map((match) => ({ token: match[0], type, index: Number(match[1]) }));
}

function validateLabelIndexes(labels, counts) {
  for (const label of labels) {
    const count = counts[label.type] || 0;
    if (!Number.isInteger(label.index) || label.index < 1 || label.index > count) {
      throw new Error(`${label.token} references ${label.type} ${label.index}, but only ${count} were provided.`);
    }
  }
}

function validateTimeline(prompt, duration) {
  if (!Number.isFinite(duration)) return [];
  const timestamps = [];
  for (const match of prompt.matchAll(/\b(?:At\s+)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?\b/gi)) {
    const seconds = Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || "0"}`);
    timestamps.push({ token: match[0], seconds });
  }
  for (const match of prompt.matchAll(/\bat\s+(\d+(?:\.\d+)?)\s+seconds?\b/gi)) {
    timestamps.push({ token: match[0], seconds: Number(match[1]) });
  }
  for (const timestamp of timestamps) {
    if (timestamp.seconds > duration + 0.0001) {
      throw new Error(`${timestamp.token} exceeds the effective video duration of ${duration}s.`);
    }
  }
  return timestamps.map((entry) => entry.seconds);
}

export function validateVideoPrompt({
  prompt,
  model,
  duration,
  imageCount = 0,
  videoCount = 0,
  audioCount = 0,
  promptMode,
  promptSource = "user",
  registry = loadVideoRegistry(),
}) {
  if (!prompt || !prompt.trim()) throw new Error("video prompt is empty.");
  const capabilities = registry.models?.[model] || {};
  const promptSkill = resolvePromptSkill(registry, model);
  if (promptMode && !PROMPT_MODES.has(promptMode)) {
    throw new Error(`unsupported --prompt-mode ${promptMode}; expected ${[...PROMPT_MODES].join(", ")}.`);
  }
  if (promptMode && promptSkill?.modes && !promptSkill.modes.includes(promptMode)) {
    throw new Error(`${promptSkill.name || promptSkill.id} does not support prompt mode ${promptMode}.`);
  }

  const legacyLabels = [
    ...collectLabels(prompt, /@图片(\d+)/gu, "image"),
    ...collectLabels(prompt, /@视频(\d+)/gu, "video"),
    ...collectLabels(prompt, /@音频(\d+)/gu, "audio"),
  ];
  const officialLabels = [
    ...collectLabels(prompt, /<Picture\s+(\d+)>/giu, "image"),
    ...collectLabels(prompt, /<Video\s+(\d+)>/giu, "video"),
    ...collectLabels(prompt, /<Audio\s+(\d+)>/giu, "audio"),
  ];
  if (legacyLabels.length && officialLabels.length) {
    throw new Error("prompt mixes legacy @图片/@视频/@音频 labels with official <Picture N>/<Video N>/<Audio N> labels.");
  }
  validateLabelIndexes([...legacyLabels, ...officialLabels], { image: imageCount, video: videoCount, audio: audioCount });

  const promptUsesVideo = [...legacyLabels, ...officialLabels].some((label) => label.type === "video");
  const supportsVideos = !Array.isArray(capabilities.supported_parameters) || capabilities.supported_parameters.includes("videos");
  if (promptUsesVideo && !supportsVideos) {
    throw new Error(`${model} does not support video references, but the prompt contains a video label.`);
  }

  const hasBaseField = BASE_FIELDS.some((field) => fieldPosition(prompt, field) >= 0);
  const hasRefField = REF_FIELDS.slice(0, 4).some((field) => fieldPosition(prompt, field) >= 0);
  let format = "plain";
  let detectedMode = null;
  if (hasRefField || promptMode === "Ref2VA") {
    validateFieldStructure(prompt, REF_FIELDS, "H3 Ref2VA");
    format = "h3-ref";
    detectedMode = "Ref2VA";
  } else if (hasBaseField || (promptMode && promptMode !== "Ref2VA")) {
    validateFieldStructure(prompt, BASE_FIELDS, "H3 base-mode");
    format = "h3-base";
    detectedMode = promptMode || "T2VA";
  }
  if (promptMode && detectedMode && promptMode !== detectedMode && detectedMode === "Ref2VA") {
    throw new Error(`--prompt-mode ${promptMode} conflicts with the detected Ref2VA six-section prompt.`);
  }

  const timestamps = validateTimeline(prompt, Number(duration));
  return {
    format,
    prompt_mode: promptMode || detectedMode,
    prompt_source: promptSource,
    label_style: officialLabels.length ? "official" : legacyLabels.length ? "legacy" : "none",
    referenced_media: {
      images: new Set([...legacyLabels, ...officialLabels].filter((label) => label.type === "image").map((label) => label.index)).size,
      videos: new Set([...legacyLabels, ...officialLabels].filter((label) => label.type === "video").map((label) => label.index)).size,
      audios: new Set([...legacyLabels, ...officialLabels].filter((label) => label.type === "audio").map((label) => label.index)).size,
    },
    timestamps,
    prompt_skill: promptSkill ? {
      id: promptSkill.id,
      vendor: promptSkill.vendor,
      name: promptSkill.name,
      path: promptSkill.path,
      optimizer: promptSkill.optimizer,
      external_prompt_api: promptSkill.external_prompt_api,
    } : null,
  };
}
