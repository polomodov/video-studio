#!/usr/bin/env python3
"""Adapt timed transcript JSON for Shorts Studio without rewriting the source."""

import argparse
import json
import math
from pathlib import Path


def normalize(raw):
    if not isinstance(raw, dict):
        raise ValueError("Ожидался JSON-объект расшифровки.")
    entries = raw.get("transcription", raw.get("segments"))
    if not isinstance(entries, list) or not entries:
        raise ValueError("Нужен непустой массив segments или transcription.")
    result = []
    previous = -1
    for index, item in enumerate(entries, 1):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            raise ValueError(f"Реплика {index}: нет текстового поля text.")
        if not item["text"].strip():
            continue
        if "start_ms" in item or "end_ms" in item:
            start, end, divisor = item.get("start_ms"), item.get("end_ms"), 1000
        elif "offsets" in item:
            offsets = item["offsets"]
            if not isinstance(offsets, dict):
                raise ValueError(f"Реплика {index}: неверные offsets.")
            start, end, divisor = offsets.get("from"), offsets.get("to"), 1000
        else:
            start, end, divisor = item.get("start"), item.get("end"), 1
        if any(isinstance(v, bool) or not isinstance(v, (int, float))
               or not math.isfinite(v) for v in (start, end)):
            raise ValueError(f"Реплика {index}: нужны конечные числовые таймкоды.")
        start, end = start / divisor, end / divisor
        if not 0 <= start < end or start < previous:
            raise ValueError(f"Реплика {index}: неверный интервал или порядок.")
        previous = start
        result.append({"start": start, "end": end, "text": item["text"]})
    if not result:
        raise ValueError("В расшифровке нет непустого текста.")
    return {"segments": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        output = normalize(json.loads(args.input.read_text(encoding="utf-8")))
        text = json.dumps(output, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
        with args.output.open("x", encoding="utf-8") as target:
            target.write(text)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    print(f"Готово: {len(output['segments'])} реплик → {args.output}")


if __name__ == "__main__":
    main()
