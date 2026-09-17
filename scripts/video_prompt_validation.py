import json
from pathlib import Path
import re


BASE_FIELDS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]
REF_FIELDS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]
PROMPT_MODES = {"T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"}


def load_video_registry(registry_path=None):
    path = Path(registry_path or Path(__file__).resolve().parent.parent / "video-models.json")
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_prompt_skill(registry, model):
    skill_id = registry.get("models", {}).get(model, {}).get("prompt_skill")
    if not skill_id:
        return None
    skill = registry.get("prompt_skills", {}).get(skill_id)
    if not skill:
        raise ValueError(f"{model} references unknown prompt skill {skill_id}.")
    return {"id": skill_id, **skill}


def field_position(prompt, field):
    match = re.search(rf"(?:^|\n)\s*{re.escape(field)}\s*:", prompt, re.IGNORECASE)
    return match.start() if match else -1


def validate_field_structure(prompt, fields, format_name):
    positions = [field_position(prompt, field) for field in fields]
    missing = [field for field, position in zip(fields, positions) if position < 0]
    if missing:
        raise ValueError(f"{format_name} prompt is missing required field(s): {', '.join(missing)}.")
    if any(current <= previous for previous, current in zip(positions, positions[1:])):
        raise ValueError(f"{format_name} prompt fields must appear in this order: {', '.join(fields)}.")


def collect_labels(prompt, pattern, media_type):
    return [{"token": match.group(0), "type": media_type, "index": int(match.group(1))} for match in re.finditer(pattern, prompt, re.IGNORECASE)]


def validate_label_indexes(labels, counts):
    for label in labels:
        count = counts.get(label["type"], 0)
        if label["index"] < 1 or label["index"] > count:
            raise ValueError(f"{label['token']} references {label['type']} {label['index']}, but only {count} were provided.")


def validate_timeline(prompt, duration):
    if duration is None:
        return []
    timestamps = []
    for match in re.finditer(r"\b(?:At\s+)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?\b", prompt, re.IGNORECASE):
        seconds = int(match.group(1)) * 60 + int(match.group(2)) + float(f"0.{match.group(3) or '0'}")
        timestamps.append((match.group(0), seconds))
    for match in re.finditer(r"\bat\s+(\d+(?:\.\d+)?)\s+seconds?\b", prompt, re.IGNORECASE):
        timestamps.append((match.group(0), float(match.group(1))))
    for token, seconds in timestamps:
        if seconds > duration + 0.0001:
            raise ValueError(f"{token} exceeds the effective video duration of {duration:g}s.")
    return [seconds for _, seconds in timestamps]


def validate_video_prompt(prompt, model, duration, image_count=0, video_count=0, audio_count=0, prompt_mode=None, prompt_source="user", registry=None):
    if not prompt or not prompt.strip():
        raise ValueError("video prompt is empty.")
    registry = registry or load_video_registry()
    capabilities = registry.get("models", {}).get(model, {})
    prompt_skill = resolve_prompt_skill(registry, model)
    if prompt_mode and prompt_mode not in PROMPT_MODES:
        raise ValueError(f"unsupported --prompt-mode {prompt_mode}; expected {', '.join(sorted(PROMPT_MODES))}.")
    if prompt_mode and prompt_skill and prompt_skill.get("modes") and prompt_mode not in prompt_skill["modes"]:
        raise ValueError(f"{prompt_skill.get('name', prompt_skill['id'])} does not support prompt mode {prompt_mode}.")

    legacy_labels = (
        collect_labels(prompt, r"@图片(\d+)", "image")
        + collect_labels(prompt, r"@视频(\d+)", "video")
        + collect_labels(prompt, r"@音频(\d+)", "audio")
    )
    official_labels = (
        collect_labels(prompt, r"<Picture\s+(\d+)>", "image")
        + collect_labels(prompt, r"<Video\s+(\d+)>", "video")
        + collect_labels(prompt, r"<Audio\s+(\d+)>", "audio")
    )
    if legacy_labels and official_labels:
        raise ValueError("prompt mixes legacy @图片/@视频/@音频 labels with official <Picture N>/<Video N>/<Audio N> labels.")
    labels = legacy_labels + official_labels
    validate_label_indexes(labels, {"image": image_count, "video": video_count, "audio": audio_count})

    prompt_uses_video = any(label["type"] == "video" for label in labels)
    supported = capabilities.get("supported_parameters")
    supports_videos = not isinstance(supported, list) or "videos" in supported
    if prompt_uses_video and not supports_videos:
        raise ValueError(f"{model} does not support video references, but the prompt contains a video label.")

    has_base_field = any(field_position(prompt, field) >= 0 for field in BASE_FIELDS)
    has_ref_field = any(field_position(prompt, field) >= 0 for field in REF_FIELDS[:4])
    format_name = "plain"
    detected_mode = None
    if has_ref_field or prompt_mode == "Ref2VA":
        validate_field_structure(prompt, REF_FIELDS, "H3 Ref2VA")
        format_name = "h3-ref"
        detected_mode = "Ref2VA"
    elif has_base_field or (prompt_mode and prompt_mode != "Ref2VA"):
        validate_field_structure(prompt, BASE_FIELDS, "H3 base-mode")
        format_name = "h3-base"
        detected_mode = prompt_mode or "T2VA"
    if prompt_mode and detected_mode == "Ref2VA" and prompt_mode != detected_mode:
        raise ValueError(f"--prompt-mode {prompt_mode} conflicts with the detected Ref2VA six-section prompt.")

    timestamps = validate_timeline(prompt, float(duration) if duration is not None else None)
    referenced_media = {}
    for media_type in ("image", "video", "audio"):
        plural = {"image": "images", "video": "videos", "audio": "audios"}[media_type]
        referenced_media[plural] = len({label["index"] for label in labels if label["type"] == media_type})
    skill_summary = None
    if prompt_skill:
        skill_summary = {key: prompt_skill.get(key) for key in ("id", "vendor", "name", "path", "optimizer", "external_prompt_api")}
    return {
        "format": format_name,
        "prompt_mode": prompt_mode or detected_mode,
        "prompt_source": prompt_source,
        "label_style": "official" if official_labels else "legacy" if legacy_labels else "none",
        "referenced_media": referenced_media,
        "timestamps": timestamps,
        "prompt_skill": skill_summary,
    }
