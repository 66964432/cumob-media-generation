#!/usr/bin/env python3

import argparse
from pathlib import Path
import json
import sys

from video_prompt_validation import validate_video_prompt


def main():
    parser = argparse.ArgumentParser(description="Validate a video prompt against model capabilities and official vendor prompt structure.")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--prompt")
    source.add_argument("--prompt-file")
    parser.add_argument("--video-model", default="minimax-h3")
    parser.add_argument("--duration", type=float, default=10)
    parser.add_argument("--image-count", type=int, default=0)
    parser.add_argument("--video-count", type=int, default=0)
    parser.add_argument("--audio-count", type=int, default=0)
    parser.add_argument("--prompt-mode", choices=["T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"])
    parser.add_argument("--prompt-source", default="user")
    args = parser.parse_args()
    prompt = args.prompt or (Path(args.prompt_file).read_text(encoding="utf-8") if args.prompt_file else sys.stdin.read())
    try:
        result = validate_video_prompt(prompt, args.video_model, args.duration, args.image_count, args.video_count, args.audio_count, args.prompt_mode, args.prompt_source)
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
