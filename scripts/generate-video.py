#!/usr/bin/env python3

import argparse
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import json


RATIOS = {"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "3:2", "2:3"}


def die(message, code=1):
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(code)


def progress(args, message):
    if not args.no_progress:
        print(f"[video-generation] {message}", file=sys.stderr, flush=True)


def parse_toml_value(raw):
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    if value == "true":
        return True
    if value == "false":
        return False
    if re.match(r"^-?\d+(\.\d+)?$", value):
        return float(value) if "." in value else int(value)
    return value


def parse_toml_lite(text):
    root, sections, current = {}, {}, None
    for line in text.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        section = re.match(r"^\[([^\]]+)\]$", trimmed)
        if section:
            current = sections.setdefault(section.group(1).replace('"', ""), {})
            continue
        pair = re.match(r"^([A-Za-z0-9_.-]+)\s*=\s*(.+)$", trimmed)
        if pair:
            (current if current is not None else root)[pair.group(1)] = parse_toml_value(pair.group(2))
    return root, sections


def env_value(name):
    if name in os.environ:
        return os.environ[name]
    lower = name.lower()
    return next((value for key, value in os.environ.items() if key.lower() == lower), None)


def resolve_config(args):
    codex_home = Path(args.codex_home or env_value("CODEX_HOME") or Path.home() / ".codex").resolve()
    config_path, auth_path = codex_home / "config.toml", codex_home / "auth.json"
    root, sections = parse_toml_lite(config_path.read_text(encoding="utf-8")) if config_path.exists() else ({}, {})
    provider_name = root.get("model_provider", "OpenAI")
    provider = sections.get(f"model_providers.{provider_name}", {})
    key_env = args.api_key_env or "OPENAI_API_KEY"
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key_env):
        die("--api-key-env must be an environment variable name.")
    base_url = (args.base_url or provider.get("base_url") or env_value("OPENAI_BASE_URL") or "https://api.cumob.com/v1").rstrip("/")
    create_url = (args.video_create_url or provider.get("video_create_url") or f"{base_url}/videos").rstrip("/")
    status_url = (args.video_status_url or provider.get("video_status_url") or f"{base_url}/status").rstrip("/")
    model = args.video_model or provider.get("video_model") or env_value("OPENAI_VIDEO_MODEL") or "minimax-h3"
    auth = json.loads(auth_path.read_text(encoding="utf-8")) if auth_path.exists() else {}
    api_key = auth.get("OPENAI_API_KEY") or env_value(key_env)
    if not api_key and not args.dry_run:
        die(f"no API key found in {auth_path} or environment variable {key_env}.")
    return {"codex_home": str(codex_home), "config_path": str(config_path), "auth_path": str(auth_path), "provider_name": provider_name, "base_url": base_url, "create_url": create_url, "status_url": status_url, "model": model, "api_key": api_key, "has_api_key": bool(api_key), "api_key_source": "codex-auth" if auth.get("OPENAI_API_KEY") else f"env:{key_env}" if api_key else "none"}


def task_state_path(args):
    return Path(args.task_file or f"{args.out}.task.json").resolve()


def write_task_state(file_path, state):
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temp = file_path.with_name(f"{file_path.name}.tmp-{os.getpid()}")
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(file_path)


def read_task_state(file_path):
    if not file_path.exists():
        return None
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception as error:
        die(f"failed to parse task file {file_path}: {error}")


def mime_type_for(path):
    return mimetypes.guess_type(str(path))[0] or "image/png"


def format_bytes(byte_count):
    return f"{round(byte_count / 1024)}KB" if byte_count < 1024 * 1024 else f"{byte_count / (1024 * 1024):.1f}MB"


def find_input_optimizer():
    if sys.platform == "darwin" and Path("/usr/bin/sips").exists():
        return {"name": "sips", "command": "/usr/bin/sips"}
    magick = shutil.which("magick")
    return {"name": "imagemagick", "command": magick} if magick else None


def input_has_alpha(image_path, optimizer):
    if optimizer["name"] == "sips":
        result = subprocess.run([optimizer["command"], "-g", "hasAlpha", str(image_path)], capture_output=True, text=True)
        return result.returncode == 0 and bool(re.search(r"hasAlpha:\s*yes", result.stdout, re.IGNORECASE))
    result = subprocess.run([optimizer["command"], "identify", "-format", "%[channels]", str(image_path)], capture_output=True, text=True)
    return result.returncode == 0 and "a" in result.stdout.lower()


def optimize_input_images(args):
    originals = list(args.image)
    args.original_images = originals
    args.input_optimization = []
    if args.no_input_optimization or not originals:
        return None
    threshold_bytes = args.input_optimize_threshold_mb * 1024 * 1024
    optimizer = find_input_optimizer()
    temp_dir = None
    prepared = []
    for index, image_path_value in enumerate(originals):
        image_path = Path(image_path_value)
        if not image_path.exists():
            die(f"image file not found: {image_path}")
        original_bytes = image_path.stat().st_size
        if original_bytes <= threshold_bytes or not optimizer:
            args.input_optimization.append({"original": str(image_path.resolve()), "optimized": False, "reason": "below-threshold" if original_bytes <= threshold_bytes else "optimizer-unavailable", "bytes": original_bytes})
            prepared.append(str(image_path))
            continue
        if temp_dir is None:
            temp_dir = Path(tempfile.mkdtemp(prefix="codex-video-input-"))
        preserve_alpha = input_has_alpha(image_path, optimizer)
        target = temp_dir / f"image-{index + 1}.{'png' if preserve_alpha else 'jpg'}"
        if optimizer["name"] == "sips":
            command = [optimizer["command"], "-Z", str(args.max_input_dimension), "-s", "format", "png" if preserve_alpha else "jpeg"]
            if not preserve_alpha:
                command.extend(["-s", "formatOptions", str(args.input_jpeg_quality)])
            command.extend([str(image_path), "--out", str(target)])
        else:
            command = [optimizer["command"], str(image_path), "-auto-orient", "-resize", f"{args.max_input_dimension}x{args.max_input_dimension}>"]
            if not preserve_alpha:
                command.extend(["-quality", str(args.input_jpeg_quality)])
            command.append(str(target))
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0 or not target.exists():
            args.input_optimization.append({"original": str(image_path.resolve()), "optimized": False, "reason": "optimizer-failed", "bytes": original_bytes})
            prepared.append(str(image_path))
            continue
        optimized_bytes = target.stat().st_size
        if optimized_bytes >= original_bytes:
            target.unlink(missing_ok=True)
            args.input_optimization.append({"original": str(image_path.resolve()), "optimized": False, "reason": "no-size-benefit", "bytes": original_bytes})
            prepared.append(str(image_path))
            continue
        progress(args, f"Optimized image {index + 1}/{len(originals)}: {format_bytes(original_bytes)} -> {format_bytes(optimized_bytes)}.")
        args.input_optimization.append({"original": str(image_path.resolve()), "path": str(target), "optimized": True, "optimizer": optimizer["name"], "original_bytes": original_bytes, "optimized_bytes": optimized_bytes})
        prepared.append(str(target))
    args.image = prepared
    return temp_dir


def validate_references(prompt, pattern, count, label):
    for match in re.finditer(pattern, prompt):
        index = int(match.group(1))
        if index > count:
            die(f"{match.group(0)} references {label} {index}, but only {count} were provided.")


def load_video_capabilities(model):
    registry_path = Path(__file__).resolve().parent.parent / "video-models.json"
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        return registry.get("models", {}).get(model, {"duration": {"min": 4, "max": 20, "default": 10}, "aspect_ratios": sorted(RATIOS)})
    except Exception:
        return {"duration": {"min": 4, "max": 20, "default": 10}, "aspect_ratios": sorted(RATIOS)}


def build_request(prompt, args, config):
    caps = load_video_capabilities(config["model"])
    requested_duration = args.duration
    duration = int(caps.get("duration", {}).get("default", 10) if requested_duration is None else requested_duration)
    adjustments = []
    resolution = None if caps.get("fixed_resolution") else (args.resolution or caps.get("default_resolution"))
    if resolution and resolution not in caps.get("resolutions", [resolution]):
        replacement = caps.get("default_resolution") or caps.get("resolutions", [resolution])[0]
        adjustments.append(f"resolution {resolution} is unsupported by {config['model']}; using {replacement}")
        resolution = replacement
    max_duration = min(int(caps.get("duration", {}).get("max", 20)), int(caps.get("resolution_duration_max", {}).get(resolution, 20)))
    min_duration = int(caps.get("duration", {}).get("min", 4))
    if duration < min_duration or duration > max_duration:
        normalized = min(max_duration, max(min_duration, duration))
        adjustments.append(f"duration {duration}s exceeds {config['model']} range {min_duration}-{max_duration}s; using {normalized}s")
        duration = normalized
    aspect_ratio = args.aspect_ratio
    ratios = caps.get("aspect_ratios", sorted(RATIOS))
    if aspect_ratio and aspect_ratio not in ratios:
        adjustments.append(f"aspect ratio {aspect_ratio} is unsupported by {config['model']}; using {ratios[0]}")
        aspect_ratio = ratios[0]
    for message in adjustments:
        progress(args, f"Parameter adjusted: {message}.")
    args.parameter_adjustments = adjustments
    image_count = len(args.image_inputs)
    if image_count > caps.get("max_images", 9):
        die(f"{config['model']} accepts at most {caps.get('max_images', 9)} reference images.")
    if len(args.video_inputs) > 3:
        die(f"{config['model']} accepts at most {caps.get('max_videos', 3)} reference videos.")
    if len(args.audio_inputs) > 3:
        die(f"{config['model']} accepts at most {caps.get('max_audios', 3)} reference audios.")
    if image_count + len(args.video_inputs) + len(args.audio_inputs) > 12:
        die(f"reference images, videos, and audios combined must not exceed {caps.get('max_total_references', 12)}.")
    if len(prompt) > 2000:
        progress(args, "Warning: prompt exceeds 2000 Chinese characters; CUMOB may lose instructions.")
    validate_references(prompt, r"@图片([1-9])", image_count, "image")
    validate_references(prompt, r"@视频([1-3])", len(args.video_inputs), "video")
    validate_references(prompt, r"@音频([1-3])", len(args.audio_inputs), "audio")
    body = {"model": config["model"], "prompt": prompt, "duration": duration, "async": True}
    if aspect_ratio:
        body["aspect_ratio"] = aspect_ratio
    if resolution:
        body["resolution"] = resolution
    if args.image_url:
        body["images"] = args.image_url
    if args.video or args.video_url or args.audio or args.audio_url:
        body["metadata"] = {}
        if args.video_inputs:
            body["metadata"]["videos"] = [value if kind == "video-url" else Path(value).name for kind, value in args.video_inputs]
        if args.audio_inputs:
            body["metadata"]["audios"] = [value if kind == "audio-url" else Path(value).name for kind, value in args.audio_inputs]
    return body


def request_json(url, api_key, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {api_key}", **({"Content-Type": "application/json"} if body is not None else {})})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
    except Exception:
        payload = {"raw": raw.decode("utf-8", errors="replace")[:500]}
    if status < 200 or status >= 300:
        error = RuntimeError(f"HTTP {status}")
        error.status, error.body = status, payload
        raise error
    return payload


def encode_multipart(body, args):
    boundary = f"----codex-video-{uuid.uuid4().hex}"
    chunks = []

    def line(value=b""):
        chunks.append(value if isinstance(value, bytes) else str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    def field(name, value):
        line(f"--{boundary}")
        line(f'Content-Disposition: form-data; name="{name}"')
        line()
        line(value)

    def file_field(name, file_path):
        path = Path(file_path)
        if not path.exists():
            die(f"{name} file not found: {path}")
        line(f"--{boundary}")
        line(f'Content-Disposition: form-data; name="{name}"; filename="{path.name}"')
        line(f"Content-Type: {mime_type_for(path)}")
        line()
        line(path.read_bytes())

    for key, value in body.items():
        if key != "images":
            if isinstance(value, (dict, list)):
                encoded = json.dumps(value, ensure_ascii=False)
            elif value is True:
                encoded = "true"
            elif value is False:
                encoded = "false"
            else:
                encoded = value
            field(key, encoded)
    for kind, value in args.image_inputs:
        field("images", value) if kind == "image-url" else file_field("images", value)
    for kind, value in args.video_inputs:
        if kind == "video": file_field("videos", value)
    for kind, value in args.audio_inputs:
        if kind == "audio": file_field("audios", value)
    line(f"--{boundary}--")
    return f"multipart/form-data; boundary={boundary}", b"".join(chunks)


def post_multipart(url, api_key, content_type, body):
    request = urllib.request.Request(url, data=body, method="POST", headers={"Authorization": f"Bearer {api_key}", "Content-Type": content_type})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
    except Exception:
        payload = {"raw": raw.decode("utf-8", errors="replace")[:500]}
    if status < 200 or status >= 300:
        error = RuntimeError(f"HTTP {status}")
        error.status, error.body = status, payload
        raise error
    return payload


def error_message(body):
    error = body.get("error") if isinstance(body, dict) else None
    return error.get("message") if isinstance(error, dict) else error or body.get("failure_reason") or body.get("message") or json.dumps(body)[:1000]


def video_url_of(body):
    for item in body.get("data", []) if isinstance(body, dict) else []:
        if item.get("video_url"):
            return item["video_url"]
    return body.get("video_url") if isinstance(body, dict) else None


def transient_network_error(error):
    return isinstance(error, (urllib.error.URLError, TimeoutError, ConnectionError, OSError))


def wait_for_video(task_id, args, config, current, state_file):
    started = time.monotonic()
    timeout = float(args.timeout or 1800)
    retries = 0
    delay = max(1.0, float(args.poll_interval or 5))
    while True:
        status = str(current.get("status", "")).lower()
        url = video_url_of(current)
        if status == "succeeded" and url:
            current["video_url"] = url
            write_task_state(state_file, {"id": task_id, "status": "succeeded", "progress": current.get("progress", 100), "created": current.get("created"), "model": current.get("model", config["model"]), "video_url": url, "output": args.out, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            return current
        if status in {"failed", "cancelled", "canceled"}:
            die(f"video task {task_id} failed: {error_message(current)}")
        if time.monotonic() - started > timeout:
            die(f"timed out waiting for video task {task_id}; use --resume {task_id} to continue later.")
        progress_value = f" ({current.get('progress')}%)" if current.get("progress") is not None else ""
        progress(args, f"Video task {task_id}: {status or 'unknown'}{progress_value}; waited {round(time.monotonic() - started)}s.")
        time.sleep(delay)
        try:
            current = request_json(f"{config['status_url']}/{urllib.parse.quote(task_id, safe='')}", config["api_key"])
            write_task_state(state_file, {"id": task_id, "status": current.get("status"), "progress": current.get("progress"), "created": current.get("created"), "model": current.get("model", config["model"]), "output": args.out, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            retries = 0
            delay = min(60, max(1.0, float(args.poll_interval or 5)) * 2)
            retry_after = current.get("retry_after", current.get("retryAfter"))
            if isinstance(retry_after, (int, float)) and retry_after > 0:
                delay = retry_after
        except Exception as error:
            retryable_http = hasattr(error, "status") and error.status in {408, 425, 429, 500, 502, 503, 504}
            if not retryable_http and not transient_network_error(error):
                die(f"video status check failed for task {task_id}: {error}")
            retries += 1
            code = f"HTTP {error.status}" if hasattr(error, "status") else str(error)
            delay = min(60, 2 ** min(retries, 6))
            progress(args, f"Status check failed ({code}); retrying ({retries}) in {delay}s. Task {task_id} is not being recreated.")


def download_video(url, output_path, config):
    parsed = urllib.parse.urlparse(url)
    hostname = (parsed.hostname or "").lower()
    is_cumob_host = hostname == "cumob.com" or hostname.endswith(".cumob.com")
    headers = {"Authorization": f"Bearer {config['api_key']}"} if is_cumob_host else {}
    request = urllib.request.Request(url, headers=headers)
    try:
        response = urllib.request.urlopen(request)
    except urllib.error.HTTPError as error:
        die(f"failed to download generated video: HTTP {error.code}")
    target = Path(output_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f"{target.name}.part-{uuid.uuid4().hex}")
    try:
        with temp.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
        if temp.stat().st_size == 0:
            die("downloaded video is empty.")
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)
    return output_path


def parse_args():
    parser = argparse.ArgumentParser(description="Generate videos with the CUMOB Videos API.")
    parser.add_argument("--prompt")
    parser.add_argument("--prompt-file")
    parser.add_argument("--out", default="generated.mp4")
    parser.add_argument("--codex-home")
    parser.add_argument("--base-url")
    parser.add_argument("--video-create-url")
    parser.add_argument("--video-status-url")
    parser.add_argument("--video-model")
    parser.add_argument("--api-key-env")
    parser.add_argument("--duration", type=int)
    parser.add_argument("--aspect-ratio")
    parser.add_argument("--resolution")
    parser.add_argument("--image", action="append", default=[])
    parser.add_argument("--image-url", action="append", default=[])
    parser.add_argument("--video", action="append", default=[])
    parser.add_argument("--audio", action="append", default=[])
    parser.add_argument("--video-url", action="append", default=[])
    parser.add_argument("--audio-url", action="append", default=[])
    parser.add_argument("--max-input-dimension", type=int, default=1536)
    parser.add_argument("--input-jpeg-quality", type=int, default=85)
    parser.add_argument("--input-optimize-threshold-mb", type=float, default=4)
    parser.add_argument("--no-input-optimization", action="store_true")
    parser.add_argument("--poll-interval", type=float, default=5)
    parser.add_argument("--timeout", type=float, default=1800)
    parser.add_argument("--resume")
    parser.add_argument("--task-file")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--no-progress", action="store_true")
    args = parser.parse_args()
    ordered, video_inputs, audio_inputs = [], [], []
    raw = sys.argv[1:]
    for index, token in enumerate(raw):
        if token in {"--image", "--image-url"} and index + 1 < len(raw):
            ordered.append(("image" if token == "--image" else "image-url", raw[index + 1]))
        elif token in {"--video", "--video-url"} and index + 1 < len(raw):
            video_inputs.append(("video" if token == "--video" else "video-url", raw[index + 1]))
        elif token in {"--audio", "--audio-url"} and index + 1 < len(raw):
            audio_inputs.append(("audio" if token == "--audio" else "audio-url", raw[index + 1]))
    args.image_inputs = ordered
    args.video_inputs = video_inputs
    args.audio_inputs = audio_inputs
    return args


def main():
    args = parse_args()
    config = resolve_config(args)
    if not args.resume and not (args.prompt or args.prompt_file or not sys.stdin.isatty()):
        die("missing --prompt, --prompt-file, or stdin prompt.")
    prompt = args.prompt or (Path(args.prompt_file).read_text(encoding="utf-8").strip() if args.prompt_file else sys.stdin.read().strip())
    state_file = task_state_path(args)
    resume_state = None
    if args.resume:
        resume_path = Path(args.resume)
        resume_state = read_task_state(resume_path.resolve()) if resume_path.exists() else read_task_state(state_file)
    resume_id = (resume_state or {}).get("id") or args.resume
    temp_dir = None if resume_id else optimize_input_images(args)
    body = None if resume_id else build_request(prompt, args, config)
    try:
        if args.dry_run:
            redacted = dict(body) if body else None
            if redacted:
                redacted["multipart_files"] = {"images": args.image, "videos": args.video, "audios": args.audio}
                redacted["input_optimization"] = args.input_optimization
            print(json.dumps({"provider": config["provider_name"], "base_url": config["base_url"], "create_endpoint": config["create_url"], "status_endpoint": f"{config['status_url']}/{{id}}", "video_model": config["model"], "transport": "multipart/form-data" if (args.image or args.video or args.audio) else "application/json", "has_api_key": config["has_api_key"], "api_key_source": config["api_key_source"], "request": redacted, "parameter_adjustments": getattr(args, "parameter_adjustments", []), "resume_id": resume_id, "task_file": str(state_file), "output": args.out}, ensure_ascii=False, indent=2))
            return
        if resume_id:
            progress(args, f"Resuming existing video task {resume_id}; no create request will be sent.")
            task = {"id": resume_id, "status": "queued"}
        else:
            progress(args, "Creating video task. Only one create request will be sent.")
            try:
                if args.image or args.video or args.audio:
                    content_type, payload = encode_multipart(body, args)
                    task = post_multipart(config["create_url"], config["api_key"], content_type, payload)
                else:
                    task = request_json(config["create_url"], config["api_key"], "POST", body)
            except Exception as error:
                if hasattr(error, "status"):
                    die(f"video API request failed with status {error.status}: {error_message(error.body)}")
                die(f"video create request could not be confirmed: {error}. Do not retry blindly; check CUMOB task history before creating another task.")
        task_id = task.get("id") or resume_id
        if not task_id:
            die("video API response did not contain an id.")
        write_task_state(state_file, {"id": task_id, "status": task.get("status"), "progress": task.get("progress"), "created": task.get("created"), "model": task.get("model", config["model"]), "output": args.out, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        completed = task if str(task.get("status", "")).lower() == "succeeded" and video_url_of(task) else wait_for_video(task_id, args, config, task, state_file)
        progress(args, "Video is ready. Downloading content.")
        written = download_video(completed["video_url"], args.out, config)
        summary = {"id": task_id, "status": completed.get("status"), "provider": config["provider_name"], "model": completed.get("model", config["model"]), "requested_duration": args.duration, "duration": completed.get("duration", body.get("duration") if body else None), "aspect_ratio": completed.get("aspect_ratio", body.get("aspect_ratio") if body else None), "resolution": completed.get("resolution", body.get("resolution") if body else "768p"), "parameter_adjustments": getattr(args, "parameter_adjustments", []), "video_url": completed["video_url"], "output": written}
        print(json.dumps(summary, ensure_ascii=False, indent=2) if args.json else f"Wrote {written}")
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
