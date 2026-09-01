#!/usr/bin/env python3

import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


HELP = """Generate or edit images with OpenAI Responses API image_generation.

Runtime:
  Requires Python 3 only. No pip packages are needed.
"""


def die(message, code=1):
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(code)


def progress(args, message):
    if not args.no_progress:
        print(f"[image-generation] {message}", file=sys.stderr, flush=True)


def start_progress(args):
    if args.no_progress:
        return lambda: None

    started_at = time.monotonic()
    stop_event = threading.Event()
    progress(args, "Request sent. Image generation can take several minutes; wait for this command to finish before retrying.")

    def loop():
        while not stop_event.wait(15):
            elapsed_seconds = round(time.monotonic() - started_at)
            progress(args, f"Still waiting for image result ({elapsed_seconds}s elapsed). Do not start another generation for the same request unless this command fails.")

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return stop_event.set


def parse_args():
    parser = argparse.ArgumentParser(description=HELP)
    parser.add_argument("--prompt")
    parser.add_argument("--prompt-file")
    parser.add_argument("--out", default="generated.png")
    parser.add_argument("--codex-home")
    parser.add_argument("--base-url")
    parser.add_argument("--image-api", choices=["responses", "images"])
    parser.add_argument("--response-model")
    parser.add_argument("--api-key", dest="deprecated_api_key", help=argparse.SUPPRESS)
    parser.add_argument("--api-key-env")
    parser.add_argument("--action", choices=["generate", "edit", "auto"])
    parser.add_argument("--image", action="append", default=[])
    parser.add_argument("--mask")
    parser.add_argument("--image-model")
    parser.add_argument("--size")
    parser.add_argument("--quality", choices=["low", "medium", "high", "auto"])
    parser.add_argument("--format", choices=["png", "webp", "jpeg"])
    parser.add_argument("--background", choices=["transparent", "opaque", "auto"])
    parser.add_argument("--input-fidelity", choices=["high", "low"])
    parser.add_argument("--moderation", choices=["auto", "low"])
    parser.add_argument("--output-compression", type=int)
    parser.add_argument("--partial-images", type=int)
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
    if args.deprecated_api_key is not None:
        die("--api-key was removed to avoid exposing secrets in command lines. Use Codex auth.json or --api-key-env <name>.")
    if not 256 <= args.max_input_dimension <= 8192:
        die("--max-input-dimension must be between 256 and 8192")
    if not 1 <= args.input_jpeg_quality <= 100:
        die("--input-jpeg-quality must be between 1 and 100")
    if not 0 <= args.input_optimize_threshold_mb <= 1024:
        die("--input-optimize-threshold-mb must be between 0 and 1024")
    return args


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
    root = {}
    sections = {}
    current = root

    for line in text.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue

        section_match = re.match(r"^\[([^\]]+)\]$", trimmed)
        if section_match:
            section = section_match.group(1).replace('"', "")
            current = sections.setdefault(section, {})
            continue

        key_value_match = re.match(r"^([A-Za-z0-9_.-]+)\s*=\s*(.+)$", trimmed)
        if not key_value_match:
            continue
        key, raw_value = key_value_match.groups()
        current[key] = parse_toml_value(raw_value)

    return {"root": root, "sections": sections}


def read_json_if_exists(file_path):
    if not file_path.exists():
        return {}
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception as error:
        die(f"failed to parse {file_path}: {error}")


def env_value(name):
    if name in os.environ:
        return os.environ[name]
    lower_name = name.lower()
    for key, value in os.environ.items():
        if key.lower() == lower_name:
            return value
    return None


def validate_env_name(name, option_name):
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
        die(f"{option_name} must be an environment variable name, not a secret value.")


def default_codex_home():
    return Path(env_value("CODEX_HOME") or Path.home() / ".codex").resolve()


def resolve_codex_config(args):
    codex_home = Path(args.codex_home).resolve() if args.codex_home else default_codex_home()
    config_path = codex_home / "config.toml"
    auth_path = codex_home / "auth.json"

    codex_config = {"root": {}, "sections": {}}
    if config_path.exists():
        codex_config = parse_toml_lite(config_path.read_text(encoding="utf-8"))

    provider_name = codex_config["root"].get("model_provider") or "OpenAI"
    provider = codex_config["sections"].get(f"model_providers.{provider_name}", {})
    auth = read_json_if_exists(auth_path)
    api_key_env_name = args.api_key_env or "OPENAI_API_KEY"
    validate_env_name(api_key_env_name, "--api-key-env")

    base_url = (
        args.base_url
        or provider.get("base_url")
        or env_value("OPENAI_BASE_URL")
        or "https://api.openai.com/v1"
    ).rstrip("/")
    image_api = (
        args.image_api
        or provider.get("image_api")
        or env_value("OPENAI_IMAGE_API")
        or "responses"
    ).lower()
    image_model = args.image_model or provider.get("image_model") or env_value("OPENAI_IMAGE_MODEL")
    response_model = args.response_model or codex_config["root"].get("model") or env_value("OPENAI_MODEL")
    auth_api_key = auth.get("OPENAI_API_KEY")
    env_api_key = env_value(api_key_env_name)
    api_key = auth_api_key or env_api_key
    api_key_source = "codex-auth" if auth_api_key else f"env:{api_key_env_name}" if env_api_key else "none"

    if image_api not in ("responses", "images"):
        die(f"unsupported image API: {image_api}. Expected responses or images.")
    if image_api == "responses" and not response_model:
        die("no Responses model found. Set Codex top-level model or pass --response-model.")
    if not api_key and not args.dry_run:
        die(f"no API key found. Expected OPENAI_API_KEY in Codex auth.json or environment variable {api_key_env_name}.")

    return {
        "codex_home": str(codex_home),
        "config_path": str(config_path),
        "auth_path": str(auth_path),
        "provider_name": provider_name,
        "base_url": base_url,
        "image_api": image_api,
        "image_model": image_model,
        "response_model": response_model,
        "api_key": api_key,
        "api_key_source": api_key_source,
        "has_api_key": bool(api_key),
    }


def read_prompt(args):
    if args.prompt:
        return args.prompt
    if args.prompt_file:
        return Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()
        if prompt:
            return prompt
    die("missing --prompt, --prompt-file, or stdin prompt.")


def mime_type_for(file_path):
    guessed, _ = mimetypes.guess_type(str(file_path))
    return guessed or "image/png"


def image_file_to_data_url(file_path):
    path = Path(file_path)
    if not path.exists():
        die(f"image file not found: {file_path}")
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type_for(path)};base64,{data}"


def format_bytes(byte_count):
    if byte_count < 1024 * 1024:
        return f"{round(byte_count / 1024)}KB"
    return f"{byte_count / (1024 * 1024):.1f}MB"


def find_input_optimizer():
    if sys.platform == "darwin" and Path("/usr/bin/sips").exists():
        return {"name": "sips", "command": "/usr/bin/sips"}
    magick = shutil.which("magick")
    if magick:
        return {"name": "imagemagick", "command": magick}
    return None


def input_has_alpha(image_path, optimizer):
    if optimizer["name"] == "sips":
        result = subprocess.run(
            [optimizer["command"], "-g", "hasAlpha", str(image_path)],
            capture_output=True,
            text=True,
        )
        return result.returncode == 0 and bool(
            re.search(r"hasAlpha:\s*yes", result.stdout, re.IGNORECASE)
        )
    result = subprocess.run(
        [optimizer["command"], "identify", "-format", "%[channels]", str(image_path)],
        capture_output=True,
        text=True,
    )
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
        if original_bytes <= threshold_bytes:
            args.input_optimization.append({
                "original": str(image_path.resolve()),
                "optimized": False,
                "reason": "below-threshold",
                "bytes": original_bytes,
            })
            prepared.append(str(image_path))
            continue
        if not optimizer:
            progress(
                args,
                f"Input {image_path} is {format_bytes(original_bytes)}, but no local optimizer is available; using the original file.",
            )
            args.input_optimization.append({
                "original": str(image_path.resolve()),
                "optimized": False,
                "reason": "optimizer-unavailable",
                "bytes": original_bytes,
            })
            prepared.append(str(image_path))
            continue

        if temp_dir is None:
            temp_dir = Path(tempfile.mkdtemp(prefix="codex-image-input-"))
        preserve_alpha = bool(input_has_alpha(image_path, optimizer))
        target_format = "png" if preserve_alpha else "jpeg"
        target = temp_dir / f"input-{index + 1}.{'png' if preserve_alpha else 'jpg'}"

        if optimizer["name"] == "sips":
            command = [
                optimizer["command"],
                "-Z",
                str(args.max_input_dimension),
                "-s",
                "format",
                target_format,
            ]
            if not preserve_alpha:
                command.extend([
                    "-s",
                    "formatOptions",
                    str(args.input_jpeg_quality),
                ])
            command.extend([str(image_path), "--out", str(target)])
        else:
            command = [
                optimizer["command"],
                str(image_path),
                "-auto-orient",
                "-resize",
                f"{args.max_input_dimension}x{args.max_input_dimension}>",
            ]
            if not preserve_alpha:
                command.extend(["-quality", str(args.input_jpeg_quality)])
            command.append(str(target))

        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0 or not target.exists():
            progress(
                args,
                f"Local optimization failed for {image_path}; using the original file.",
            )
            args.input_optimization.append({
                "original": str(image_path.resolve()),
                "optimized": False,
                "reason": "optimizer-failed",
                "bytes": original_bytes,
            })
            prepared.append(str(image_path))
            continue

        optimized_bytes = target.stat().st_size
        if optimized_bytes >= original_bytes:
            target.unlink(missing_ok=True)
            args.input_optimization.append({
                "original": str(image_path.resolve()),
                "optimized": False,
                "reason": "no-size-benefit",
                "bytes": original_bytes,
            })
            prepared.append(str(image_path))
            continue

        progress(
            args,
            f"Optimized input {index + 1}/{len(originals)} locally with {optimizer['name']}: {format_bytes(original_bytes)} -> {format_bytes(optimized_bytes)}.",
        )
        args.input_optimization.append({
            "original": str(image_path.resolve()),
            "path": str(target),
            "optimized": True,
            "optimizer": optimizer["name"],
            "original_bytes": original_bytes,
            "optimized_bytes": optimized_bytes,
            "max_dimension": args.max_input_dimension,
            "output_format": target_format,
            "jpeg_quality": None if preserve_alpha else args.input_jpeg_quality,
        })
        prepared.append(str(target))

    args.image = prepared
    return temp_dir


def build_tool(args):
    tool = {"type": "image_generation"}
    option_map = {
        "action": "action",
        "background": "background",
        "input_fidelity": "input_fidelity",
        "image_model": "model",
        "moderation": "moderation",
        "output_compression": "output_compression",
        "format": "output_format",
        "partial_images": "partial_images",
        "quality": "quality",
        "size": "size",
    }

    for arg_name, body_name in option_map.items():
        value = getattr(args, arg_name)
        if value is not None:
            tool[body_name] = value

    if args.mask:
        tool["input_image_mask"] = {"image_url": image_file_to_data_url(args.mask)}

    if "action" not in tool and not args.image:
        tool["action"] = "generate"

    return tool


def build_input(prompt, args):
    if not args.image:
        return prompt

    return [
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": prompt},
                *[
                    {"type": "input_image", "image_url": image_file_to_data_url(image_path)}
                    for image_path in args.image
                ],
            ],
        }
    ]


def output_path_for(base_path, index, count, output_format):
    path = Path(base_path)
    if count == 1:
        return path
    suffix = path.suffix or f".{output_format or 'png'}"
    return path.with_name(f"{path.stem}-{index + 1}{suffix}")


def redact_request(body):
    def redact(value):
        if isinstance(value, dict):
            return {key: redact(item) for key, item in value.items()}
        if isinstance(value, list):
            return [redact(item) for item in value]
        if isinstance(value, str) and value.startswith("data:") and "," in value:
            return value.split(",", 1)[0] + ",<base64-redacted>"
        return value

    return redact(body)


def summarize_response(response_json):
    return {
        "id": response_json.get("id"),
        "status": response_json.get("status"),
        "error": response_json.get("error", {}).get("message") if isinstance(response_json.get("error"), dict) else response_json.get("error"),
        "output": [
            {
                "type": item.get("type"),
                "status": item.get("status"),
                "role": item.get("role"),
                "content_types": [content.get("type") for content in item.get("content", [])] if isinstance(item.get("content"), list) else None,
                "error": item.get("error", {}).get("message") if isinstance(item.get("error"), dict) else item.get("error"),
            }
            for item in response_json.get("output", [])
        ],
    }


def parse_response_json(status, response_bytes):
    text = response_bytes.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except Exception:
        die(f"API returned non-JSON response with status {status}: {text[:500]}")


def task_state_path(args):
    return Path(args.task_file or f"{args.out}.task.json").resolve()


def write_task_state(file_path, state):
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f"{file_path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(file_path)


def read_task_state(file_path):
    if not file_path.exists():
        return None
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception as error:
        die(f"failed to parse task file {file_path}: {error}")


def post_json(endpoint, api_key, body):
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def resolve_action(args):
    if args.action and args.action != "auto":
        return args.action
    return "edit" if args.image or args.mask else "generate"


def build_images_request(prompt, args, config):
    action = resolve_action(args)
    model = args.image_model or config["image_model"]
    if not model:
        die("no image model found. Set provider image_model or pass --image-model.")

    fields = {"model": model, "prompt": prompt, "async": True}
    option_map = {
        "background": "background",
        "input_fidelity": "input_fidelity",
        "moderation": "moderation",
        "output_compression": "output_compression",
        "format": "output_format",
        "quality": "quality",
        "size": "size",
    }
    for arg_name, field_name in option_map.items():
        value = getattr(args, arg_name)
        if value is not None:
            fields[field_name] = value

    endpoint_name = "edits" if action == "edit" else "generations"
    return {
        "action": action,
        "endpoint": f"{config['base_url']}/images/{endpoint_name}",
        "fields": fields,
    }


def encode_multipart(fields, image_paths, mask_path=None):
    boundary = f"----codex-image-{uuid.uuid4().hex}"
    chunks = []

    def add_line(value=b""):
        chunks.append(value if isinstance(value, bytes) else value.encode("utf-8"))
        chunks.append(b"\r\n")

    for name, value in fields.items():
        add_line(f"--{boundary}")
        add_line(f'Content-Disposition: form-data; name="{name}"')
        add_line()
        add_line("true" if value is True else "false" if value is False else str(value))

    image_field = "image" if len(image_paths) == 1 else "image[]"
    for image_path_value in image_paths:
        image_path = Path(image_path_value)
        if not image_path.exists():
            die(f"image file not found: {image_path}")
        add_line(f"--{boundary}")
        add_line(
            f'Content-Disposition: form-data; name="{image_field}"; filename="{image_path.name}"'
        )
        add_line(f"Content-Type: {mime_type_for(image_path)}")
        add_line()
        add_line(image_path.read_bytes())

    if mask_path:
        mask = Path(mask_path)
        if not mask.exists():
            die(f"mask file not found: {mask}")
        add_line(f"--{boundary}")
        add_line(f'Content-Disposition: form-data; name="mask"; filename="{mask.name}"')
        add_line(f"Content-Type: {mime_type_for(mask)}")
        add_line()
        add_line(mask.read_bytes())

    add_line(f"--{boundary}--")
    return f"multipart/form-data; boundary={boundary}", b"".join(chunks)


def post_bytes(endpoint, api_key, content_type, body):
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": content_type,
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def request_json(url, api_key):
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    payload = parse_response_json(status, raw)
    if status < 200 or status >= 300:
        error = RuntimeError(f"HTTP {status}")
        error.status, error.body = status, payload
        raise error
    return payload


def image_data_available(response_json):
    return any(item.get("url") or item.get("b64_json") for item in response_json.get("data") or [])


def image_error_message(body):
    error = body.get("error") if isinstance(body, dict) else None
    return (error.get("message") if isinstance(error, dict) else error) or body.get("failure_reason") or body.get("message") or json.dumps(body)[:1000]


def wait_for_image(task_id, args, config, current, output_format, state_file):
    started = time.monotonic()
    timeout = float(args.timeout or 1800)
    delay = max(1.0, float(args.poll_interval or 5))
    retries = 0
    while True:
        status = str(current.get("status", "")).lower()
        if status == "succeeded" and image_data_available(current):
            write_task_state(state_file, {"id": task_id, "status": status, "progress": current.get("progress", 100), "created": current.get("created"), "model": current.get("model", config["image_model"]), "output": args.out, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            return current
        if status in {"failed", "cancelled", "canceled"}:
            die(f"image task {task_id} failed: {image_error_message(current)}")
        if time.monotonic() - started > timeout:
            die(f"timed out waiting for image task {task_id}; use --resume {task_id} to continue later.")
        progress_value = f" ({current.get('progress')}%)" if current.get("progress") is not None else ""
        progress(args, f"Image task {task_id}: {status or 'unknown'}{progress_value}; waited {round(time.monotonic() - started)}s.")
        time.sleep(delay)
        try:
            current = request_json(f"{config['base_url']}/status/{urllib.parse.quote(task_id, safe='')}", config["api_key"])
            write_task_state(state_file, {"id": task_id, "status": current.get("status"), "progress": current.get("progress"), "created": current.get("created"), "model": current.get("model", config["image_model"]), "output": args.out, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            retries = 0
            delay = min(60, max(1.0, float(args.poll_interval or 5)) * 2)
            retry_after = current.get("retry_after", current.get("retryAfter"))
            if isinstance(retry_after, (int, float)) and retry_after > 0:
                delay = retry_after
        except Exception as error:
            retryable_http = hasattr(error, "status") and error.status in {408, 425, 429, 500, 502, 503, 504}
            retryable_network = isinstance(error, (urllib.error.URLError, TimeoutError, ConnectionError, OSError))
            if not retryable_http and not retryable_network:
                die(f"image status check failed for task {task_id}: {error}")
            retries += 1
            delay = min(60, 2 ** min(retries, 6))
            code = f"HTTP {error.status}" if hasattr(error, "status") else str(error)
            progress(args, f"Status check failed ({code}); retrying ({retries}) in {delay}s. Task {task_id} is not being recreated.")


def download_image(url):
    try:
        with urllib.request.urlopen(url) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        die(f"failed to download generated image: HTTP {error.code}")


def write_images_results(response_json, output_path, output_format):
    results = response_json.get("data") or []
    if not results:
        die(f"Images API response contained no data: {json.dumps(response_json)[:1000]}")

    written = []
    for index, result in enumerate(results):
        if result.get("b64_json"):
            image_bytes = base64.b64decode(result["b64_json"])
        elif result.get("url"):
            image_bytes = download_image(result["url"])
        else:
            die(
                "image result contained neither b64_json nor url: "
                + json.dumps(result)[:1000]
            )
        target = output_path_for(output_path, index, len(results), output_format)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(image_bytes)
        written.append(str(target))
    return written


def run_images_api(prompt, args, config):
    image_request = build_images_request(prompt, args, config)
    if image_request["action"] == "edit" and not args.image:
        die("Images API edit mode requires at least one --image.")
    if image_request["action"] == "generate" and (args.image or args.mask):
        die("Images API generate mode does not accept --image or --mask. Use --action edit.")

    state_file = task_state_path(args)
    resume_state = None
    if args.resume:
        resume_path = Path(args.resume)
        resume_state = read_task_state(resume_path.resolve()) if resume_path.exists() else read_task_state(state_file)
    resume_id = (resume_state or {}).get("id") or args.resume

    if args.dry_run:
        print(json.dumps({
            "codex_home": config["codex_home"],
            "config_path": config["config_path"],
            "auth_path": config["auth_path"],
            "provider": config["provider_name"],
            "image_api": config["image_api"],
            "base_url": config["base_url"],
            "endpoint": image_request["endpoint"],
            "image_model": image_request["fields"]["model"],
            "has_api_key": config["has_api_key"],
            "api_key_source": config["api_key_source"],
            "request": {
                **image_request["fields"],
                "images": [str(Path(image).resolve()) for image in args.image],
                "original_images": [
                    str(Path(image).resolve()) for image in args.original_images
                ],
                "input_optimization": args.input_optimization,
                "mask": str(Path(args.mask).resolve()) if args.mask else None,
                "task_file": str(state_file),
                "resume_id": resume_id,
            },
        }, indent=2))
        return

    output_format = (
        image_request["fields"].get("output_format")
        or Path(args.out).suffix.lstrip(".")
        or "png"
    )
    if resume_id:
        progress(args, f"Resuming existing image task {resume_id}; no create request will be sent.")
        completed = wait_for_image(resume_id, args, config, {"id": resume_id, "status": "queued"}, output_format, state_file)
        written = write_images_results(completed, args.out, output_format)
        summary = {"id": resume_id, "status": completed.get("status"), "provider": config["provider_name"], "image_api": config["image_api"], "image_model": config["image_model"], "outputs": written}
        print(json.dumps(summary, indent=2) if args.json else "\n".join(f"Wrote {file_path}" for file_path in written))
        return

    stop_progress = start_progress(args)
    try:
        if image_request["action"] == "generate":
            status, response_bytes = post_json(
                image_request["endpoint"], config["api_key"], image_request["fields"]
            )
        else:
            content_type, body = encode_multipart(
                image_request["fields"], args.image, args.mask
            )
            status, response_bytes = post_bytes(
                image_request["endpoint"], config["api_key"], content_type, body
            )
    finally:
        stop_progress()
    progress(args, "Response received. Decoding image task.")

    response_json = parse_response_json(status, response_bytes)
    if status < 200 or status >= 300:
        error = response_json.get("error")
        message = (
            error.get("message")
            if isinstance(error, dict)
            else error
            or response_json.get("message")
            or json.dumps(response_json)[:1000]
        )
        die(f"API request failed with status {status}: {message}")

    task_id = response_json.get("id")
    completed = response_json
    if not image_data_available(response_json) or str(response_json.get("status", "")).lower() != "succeeded":
        if not task_id:
            die(f"Images API response contained neither final data nor a task id: {json.dumps(response_json)[:1000]}")
        write_task_state(state_file, {"id": task_id, "status": response_json.get("status"), "progress": response_json.get("progress"), "created": response_json.get("created"), "model": image_request["fields"]["model"], "output": args.out, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        completed = wait_for_image(task_id, args, config, response_json, output_format, state_file)
    written = write_images_results(completed, args.out, output_format)
    summary = {
        "provider": config["provider_name"],
        "image_api": config["image_api"],
        "base_url": config["base_url"],
        "image_model": image_request["fields"]["model"],
        "id": task_id or completed.get("id"),
        "outputs": written,
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        for file_path in written:
            print(f"Wrote {file_path}")


def run_responses_api(prompt, args, config):
    tool = build_tool(args)
    if "model" not in tool and config["image_model"]:
        tool["model"] = config["image_model"]
    request_body = {
        "model": config["response_model"],
        "input": build_input(prompt, args),
        "tools": [tool],
    }
    endpoint = f"{config['base_url']}/responses"

    if args.dry_run:
        print(json.dumps({
            "codex_home": config["codex_home"],
            "config_path": config["config_path"],
            "auth_path": config["auth_path"],
            "provider": config["provider_name"],
            "base_url": config["base_url"],
            "endpoint": endpoint,
            "response_model": config["response_model"],
            "has_api_key": config["has_api_key"],
            "api_key_source": config["api_key_source"],
            "original_images": [
                str(Path(image).resolve()) for image in args.original_images
            ],
            "input_optimization": args.input_optimization,
            "request": redact_request(request_body),
        }, indent=2))
        return

    stop_progress = start_progress(args)
    try:
        status, response_bytes = post_json(endpoint, config["api_key"], request_body)
    finally:
        stop_progress()
    progress(args, "Response received. Decoding image data.")

    response_json = parse_response_json(status, response_bytes)
    if status < 200 or status >= 300:
        message = response_json.get("error", {}).get("message") or response_json.get("message") or json.dumps(response_json)[:1000]
        die(f"API request failed with status {status}: {message}")

    image_results = [
        item["result"]
        for item in response_json.get("output", [])
        if item.get("type") == "image_generation_call" and item.get("result")
    ]
    if not image_results:
        print(json.dumps(summarize_response(response_json), indent=2), file=sys.stderr)
        die("response did not contain output[].type == image_generation_call with a result.")

    output_format = tool.get("output_format") or Path(args.out).suffix.lstrip(".") or "png"
    written = []
    for index, image_base64 in enumerate(image_results):
        target = output_path_for(args.out, index, len(image_results), output_format)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(image_base64))
        written.append(str(target))

    summary = {
        "response_id": response_json.get("id"),
        "provider": config["provider_name"],
        "base_url": config["base_url"],
        "response_model": config["response_model"],
        "image_model": tool.get("model") or "api-default",
        "outputs": written,
    }

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        for file_path in written:
            print(f"Wrote {file_path}")


def main():
    args = parse_args()
    prompt = None if args.resume else read_prompt(args)
    config = resolve_codex_config(args)
    if args.resume and config["image_api"] != "images":
        die("--resume is only supported for CUMOB Images API tasks, not Responses API tasks.")
    temp_dir = None if args.resume else optimize_input_images(args)
    try:
        if config["image_api"] == "images":
            run_images_api(prompt, args, config)
            return
        run_responses_api(prompt, args, config)
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
