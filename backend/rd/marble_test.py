"""
ArticulAIT — World Labs Marble API evaluation script (R&D ONLY)

Standalone tool to test whether World Labs' Marble ("World API") could be a
viable replacement for our reconstruction stage. This file is deliberately
isolated under backend/rd/ and imports NOTHING from the rest of the backend
(no reconstruction_service.py, no pose_router.py, no pipeline code) and is
not wired into the FastAPI app. It's a script you run by hand from the
command line, not production code.

No World Labs Python SDK exists on PyPI as of 2026-09 (checked via PyPI/web
search before writing this) — this talks to the REST API directly with
`requests`.

── API shape this script was written against ───────────────────────────────
Verified 2026-09-07 against the live docs at https://docs.worldlabs.ai/api
(and its /reference/worlds/generate.md, /reference/media-assets/*.md sub-
pages) — NOT guessed. Docs can drift from the real API though, so if any
request in here comes back with a shape this script doesn't expect, the
error handling below will surface the raw response body — paste that back
rather than assuming this script's parsing is right.

  Auth:        header "WLT-Api-Key: <key>" on every request.
  Base URL:    https://api.worldlabs.ai

  1) POST /marble/v1/media-assets:prepare_upload
       body: {"file_name": str, "kind": "image", "extension": str}
       resp: {"media_asset": {"media_asset_id": str, ...},
              "upload_info": {"upload_url": str, "upload_method": "PUT",
                               "required_headers": {...} | null}}
     Then a plain PUT of the raw file bytes to upload_info.upload_url, with
     any upload_info.required_headers merged in. No separate "finalize"
     call — the docs say to just reference media_asset_id once the PUT
     succeeds.

  2) POST /marble/v1/worlds:generate
       body: {
         "display_name": str,
         "model": "marble-1.0-draft"|"marble-1.0"|"marble-1.1"|"marble-1.1-plus",
         "world_prompt": {
           "type": "multi-image",
           "multi_image_prompt": [
             {"azimuth": <deg 0-360>,
              "content": {"source": "uri", "uri": str}
                          | {"source": "media_asset", "media_asset_id": str}}
           ],
           "text_prompt": str  (optional)
         }
       }
       resp: {"operation_id": str, "done": bool, "cost": <optional>, ...}

  3) GET /marble/v1/operations/{operation_id}
       resp: {"operation_id": str, "done": bool, "error": {...}|null,
              "metadata": {"progress": {"status": str, "description": str},
                            "world_id": str},
              "response": {   # present once done
                "id": str,                       # world_id
                "world_marble_url": str,
                "assets": {
                  "caption": str,
                  "thumbnail_url": str,
                  "splats": {"spz_urls": {"100k": str, "500k": str,
                                            "full_res": str}, ...},
                  "mesh": {...}, "imagery": {...}
                }}}

Usage:
    export WORLDLABS_API_KEY=...
    python backend/rd/marble_test.py --images-dir path/to/room_photos
    python backend/rd/marble_test.py --images-dir path/to/room_photos --dry-run
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

try:
    # Convenience only: if python-dotenv is installed (it already is, for
    # the main backend) and a .env exists at the repo root, load it so
    # WORLDLABS_API_KEY=... in there is picked up without an extra manual
    # `export`. Never required — get_api_key() below still just reads
    # os.environ, so a real shell-exported var works with or without this.
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except ImportError:
    pass

# ═══════════════════════════════════════════════════════════════════════
# CONFIGURATION — edit these for your test run
# ═══════════════════════════════════════════════════════════════════════

# "upload": upload each local file in --images-dir as a media asset first.
# "url":    skip upload entirely and reference each image by a public URL
#           you already have (see FILENAME_URLS below).
INPUT_MODE = "upload"  # "upload" | "url"

# Maps each input photo's filename to its azimuth in degrees around the
# room: 0=front, 90=right, 180=back, 270=left. Add one entry per photo.
# In INPUT_MODE == "upload", these filenames must exist in --images-dir.
# In INPUT_MODE == "url", these filenames are just labels — the actual
# source is FILENAME_URLS[filename] below.
FILENAME_AZIMUTHS: Dict[str, float] = {
    "room_front_azimuth0.jpg": 0,
    "room_right_azimuth90.jpg": 90,
    "room_back_azimuth180.jpg": 180,
    "room_left_azimuth270.jpg": 270,
}

# Only read when INPUT_MODE == "url". Must have one entry per key in
# FILENAME_AZIMUTHS above, pointing at a publicly-reachable image URL.
FILENAME_URLS: Dict[str, str] = {
    # "front.jpg": "https://example.com/front.jpg",
}

MODEL = "marble-1.1"
DISPLAY_NAME = "ArticulAIT R&D Marble Test"
# Optional freeform text hint; leave as None to let Marble auto-caption.
TEXT_PROMPT: Optional[str] = None

# ═══════════════════════════════════════════════════════════════════════

API_BASE = "https://api.worldlabs.ai"
API_KEY_ENV_VAR = "WORLDLABS_API_KEY"

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / "output"


class MarbleTestError(Exception):
    """Any error this script raises deliberately (as opposed to letting a
    bare stack trace from `requests` bubble up) — main() catches this
    specifically and prints just the message, not a traceback."""


def get_api_key() -> str:
    key = os.environ.get(API_KEY_ENV_VAR)
    if not key:
        raise MarbleTestError(
            f"Environment variable {API_KEY_ENV_VAR} is not set. "
            f"Run `export {API_KEY_ENV_VAR}=your_key_here` (or the Windows/"
            f"PowerShell equivalent) before running this script. The key is "
            f"never hardcoded here on purpose."
        )
    return key


def _describe_http_error(resp: requests.Response, context: str) -> str:
    """Turns a failed requests.Response into one distinct, readable message
    instead of a bare stack trace, per-status-code where it's worth being
    specific."""
    status = resp.status_code
    try:
        body_preview = json.dumps(resp.json(), indent=2)[:2000]
    except ValueError:
        body_preview = resp.text[:2000]

    if status in (401, 403):
        return (
            f"{context} failed with HTTP {status} (authentication rejected). "
            f"Check that {API_KEY_ENV_VAR} is set to a valid, current Marble "
            f"API key. Response body:\n{body_preview}"
        )
    if status == 404:
        return f"{context} failed with HTTP 404 (not found). Response body:\n{body_preview}"
    if status == 429:
        return f"{context} failed with HTTP 429 (rate limited). Response body:\n{body_preview}"
    if 500 <= status < 600:
        return (
            f"{context} failed with HTTP {status} (server-side error on "
            f"World Labs' end, not something wrong with this script's "
            f"request). Response body:\n{body_preview}"
        )
    return f"{context} failed with HTTP {status}. Response body:\n{body_preview}"


def prepare_upload(session: requests.Session, api_key: str, file_path: Path) -> str:
    """POST /marble/v1/media-assets:prepare_upload, then PUT the raw file
    bytes to the returned signed upload URL. Returns the media_asset_id."""
    extension = file_path.suffix.lstrip(".").lower()
    try:
        resp = session.post(
            f"{API_BASE}/marble/v1/media-assets:prepare_upload",
            headers={"WLT-Api-Key": api_key, "Content-Type": "application/json"},
            json={"file_name": file_path.name, "kind": "image", "extension": extension},
            timeout=30,
        )
    except requests.RequestException as e:
        raise MarbleTestError(f"Network error preparing upload for {file_path.name}: {e}")

    if not resp.ok:
        raise MarbleTestError(_describe_http_error(resp, f"prepare_upload for {file_path.name}"))

    data = resp.json()
    media_asset_id = data.get("media_asset", {}).get("media_asset_id")
    upload_info = data.get("upload_info", {})
    upload_url = upload_info.get("upload_url")
    if not media_asset_id or not upload_url:
        raise MarbleTestError(
            f"prepare_upload for {file_path.name} returned an unexpected shape "
            f"(missing media_asset.media_asset_id or upload_info.upload_url). "
            f"Paste this raw response back so the parsing here can be fixed:\n"
            f"{json.dumps(data, indent=2)[:2000]}"
        )

    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    put_headers = {"Content-Type": content_type}
    put_headers.update(upload_info.get("required_headers") or {})

    try:
        with open(file_path, "rb") as f:
            put_resp = session.put(upload_url, headers=put_headers, data=f, timeout=120)
    except requests.RequestException as e:
        raise MarbleTestError(f"Network error uploading bytes for {file_path.name}: {e}")

    if not put_resp.ok:
        raise MarbleTestError(
            f"Uploading {file_path.name} to the signed upload URL failed with "
            f"HTTP {put_resp.status_code}. Response body:\n{put_resp.text[:2000]}"
        )

    print(f"  ✔ uploaded {file_path.name} -> media_asset_id={media_asset_id}")
    return media_asset_id


def build_multi_image_prompt(
    session: requests.Session,
    api_key: str,
    images_dir: Optional[Path],
    dry_run: bool,
) -> List[Dict[str, Any]]:
    """Builds the multi_image_prompt array per FILENAME_AZIMUTHS /
    FILENAME_URLS / INPUT_MODE above. Uploading (INPUT_MODE == "upload") is
    skipped entirely in --dry-run, since the whole point of --dry-run is to
    not touch the network / spend anything."""
    if not FILENAME_AZIMUTHS:
        raise MarbleTestError(
            "FILENAME_AZIMUTHS at the top of marble_test.py is empty — add at "
            "least one filename -> azimuth entry before running."
        )

    entries: List[Dict[str, Any]] = []

    if INPUT_MODE == "url":
        missing = [f for f in FILENAME_AZIMUTHS if f not in FILENAME_URLS]
        if missing:
            raise MarbleTestError(
                f"INPUT_MODE is 'url' but FILENAME_URLS is missing an entry for: "
                f"{missing}. Every key in FILENAME_AZIMUTHS needs a matching URL."
            )
        for filename, azimuth in FILENAME_AZIMUTHS.items():
            entries.append({
                "azimuth": azimuth,
                "content": {"source": "uri", "uri": FILENAME_URLS[filename]},
            })
        return entries

    if INPUT_MODE != "upload":
        raise MarbleTestError(f"INPUT_MODE must be 'upload' or 'url', got: {INPUT_MODE!r}")

    if not images_dir:
        raise MarbleTestError("INPUT_MODE is 'upload' but --images-dir was not given.")
    if not images_dir.is_dir():
        raise MarbleTestError(f"--images-dir does not exist or is not a directory: {images_dir}")

    missing_files = []
    for filename, azimuth in FILENAME_AZIMUTHS.items():
        file_path = images_dir / filename
        if not file_path.is_file():
            missing_files.append(filename)
            continue
        if dry_run:
            entries.append({
                "azimuth": azimuth,
                "content": {"source": "media_asset", "media_asset_id": f"<DRY_RUN_PLACEHOLDER:{filename}>"},
            })
        else:
            media_asset_id = prepare_upload(session, api_key, file_path)
            entries.append({
                "azimuth": azimuth,
                "content": {"source": "media_asset", "media_asset_id": media_asset_id},
            })

    if missing_files:
        raise MarbleTestError(
            f"These filenames are listed in FILENAME_AZIMUTHS but don't exist "
            f"in --images-dir ({images_dir}): {missing_files}. Either add the "
            f"files or edit FILENAME_AZIMUTHS to match what's actually there."
        )

    return entries


def build_generate_payload(multi_image_prompt: List[Dict[str, Any]]) -> Dict[str, Any]:
    world_prompt: Dict[str, Any] = {
        "type": "multi-image",
        "multi_image_prompt": multi_image_prompt,
    }
    if TEXT_PROMPT:
        world_prompt["text_prompt"] = TEXT_PROMPT

    return {
        "display_name": DISPLAY_NAME,
        "model": MODEL,
        "world_prompt": world_prompt,
    }


def submit_generation(session: requests.Session, api_key: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        resp = session.post(
            f"{API_BASE}/marble/v1/worlds:generate",
            headers={"WLT-Api-Key": api_key, "Content-Type": "application/json"},
            json=payload,
            timeout=30,
        )
    except requests.RequestException as e:
        raise MarbleTestError(f"Network error submitting worlds:generate: {e}")

    if not resp.ok:
        raise MarbleTestError(_describe_http_error(resp, "worlds:generate"))

    data = resp.json()
    if "operation_id" not in data:
        raise MarbleTestError(
            f"worlds:generate response is missing 'operation_id'. Paste this "
            f"raw response back:\n{json.dumps(data, indent=2)[:2000]}"
        )
    return data


def poll_operation(
    session: requests.Session,
    api_key: str,
    operation_id: str,
    timeout_seconds: int,
    poll_interval_seconds: int,
) -> Dict[str, Any]:
    print(f"Polling GET /marble/v1/operations/{operation_id} every {poll_interval_seconds}s "
          f"(timeout {timeout_seconds}s)...")
    start = time.monotonic()

    while True:
        elapsed = time.monotonic() - start
        if elapsed > timeout_seconds:
            raise MarbleTestError(
                f"Timed out after {int(elapsed)}s waiting for world generation to "
                f"finish (operation_id={operation_id}). The job may still be "
                f"running server-side — you can re-check manually with:\n"
                f'  curl -H "WLT-Api-Key: $WORLDLABS_API_KEY" '
                f'"{API_BASE}/marble/v1/operations/{operation_id}"'
            )

        try:
            resp = session.get(
                f"{API_BASE}/marble/v1/operations/{operation_id}",
                headers={"WLT-Api-Key": api_key},
                timeout=30,
            )
        except requests.RequestException as e:
            raise MarbleTestError(f"Network error polling operation {operation_id}: {e}")

        if not resp.ok:
            raise MarbleTestError(_describe_http_error(resp, f"polling operation {operation_id}"))

        data = resp.json()

        if data.get("error"):
            raise MarbleTestError(
                f"World generation failed (operation_id={operation_id}). "
                f"Error from API:\n{json.dumps(data['error'], indent=2)}"
            )

        progress = (data.get("metadata") or {}).get("progress") or {}
        status = progress.get("status", "?")
        description = progress.get("description", "")
        print(f"  [{int(elapsed)}s] status={status} {description}".rstrip())

        if data.get("done"):
            return data

        time.sleep(poll_interval_seconds)


def extract_result(operation_data: Dict[str, Any]) -> Dict[str, Any]:
    world = operation_data.get("response")
    if not world:
        raise MarbleTestError(
            "Operation is done but has no 'response' field with the world "
            "data. Paste this raw response back:\n"
            f"{json.dumps(operation_data, indent=2)[:2000]}"
        )

    # Corrected 2026-09-07 against a REAL response (not the docs, which say
    # "id" and always include "world_marble_url" — neither held up): the
    # world identifier field is actually "world_id", and "world_marble_url"
    # isn't present in the response at all, so it's constructed from
    # world_id using the URL pattern World Labs' own docs show elsewhere.
    world_id = world.get("world_id") or world.get("id")
    world_marble_url = world.get("world_marble_url") or (
        f"https://marble.worldlabs.ai/world/{world_id}" if world_id else None
    )
    spz_urls = ((world.get("assets") or {}).get("splats") or {}).get("spz_urls") or {}

    if not world_id or not spz_urls:
        raise MarbleTestError(
            "Completed world response is missing 'world_id'/'id' or "
            "assets.splats.spz_urls. Paste this raw response back so the "
            "parsing here can be fixed:\n"
            f"{json.dumps(world, indent=2)[:2000]}"
        )

    # Prefer the highest-quality tier available.
    chosen_tier = next((t for t in ("full_res", "500k", "100k") if t in spz_urls), None)
    if not chosen_tier:
        raise MarbleTestError(
            f"spz_urls has none of the expected tiers (full_res/500k/100k) — "
            f"got keys: {list(spz_urls.keys())}"
        )

    return {
        "world_id": world_id,
        "world_marble_url": world_marble_url,
        "spz_url": spz_urls[chosen_tier],
        "spz_tier": chosen_tier,
    }


def download_file(session: requests.Session, url: str, dest_path: Path) -> None:
    try:
        resp = session.get(url, timeout=120, stream=True)
    except requests.RequestException as e:
        raise MarbleTestError(f"Network error downloading splat from {url}: {e}")

    if not resp.ok:
        raise MarbleTestError(_describe_http_error(resp, f"downloading splat from {url}"))

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1 << 16):
            f.write(chunk)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="R&D script: test World Labs Marble API as a possible reconstruction replacement."
    )
    parser.add_argument(
        "--images-dir", type=Path, default=None,
        help="Folder of 4-8 test photos (required when INPUT_MODE == 'upload').",
    )
    parser.add_argument(
        "--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR,
        help=f"Where to write output (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument("--timeout", type=int, default=300, help="Max seconds to poll before giving up (default 300).")
    parser.add_argument("--poll-interval", type=int, default=5, help="Seconds between polls (default 5).")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the worlds:generate request payload and exit — no network calls, no credits spent.",
    )
    parser.add_argument(
        "--resume-operation-id", type=str, default=None,
        help=(
            "Skip upload + worlds:generate entirely and just poll + download an "
            "operation_id that was already submitted (e.g. from a previous run's "
            "printed 'operation_id=...' line). Use this after a network hiccup "
            "mid-poll instead of resubmitting and spending credits again."
        ),
    )
    args = parser.parse_args()

    if args.dry_run and args.resume_operation_id:
        print("✘ --dry-run and --resume-operation-id don't make sense together.", file=sys.stderr)
        return 1

    print(f"INPUT_MODE={INPUT_MODE!r}  model={MODEL!r}  dry_run={args.dry_run}")

    session = requests.Session()

    try:
        api_key = None if args.dry_run else get_api_key()

        if args.resume_operation_id:
            submit_cost = None
            operation_id = args.resume_operation_id
            print(f"Resuming existing operation_id={operation_id} (no upload, no new generate request)")
        else:
            multi_image_prompt = build_multi_image_prompt(session, api_key, args.images_dir, args.dry_run)
            payload = build_generate_payload(multi_image_prompt)

            if args.dry_run:
                print("\n--dry-run: worlds:generate request payload (NOT sent):\n")
                print(json.dumps(payload, indent=2))
                print(
                    "\nNote: content.media_asset_id values above are dry-run "
                    "placeholders — a real run uploads each file first and uses "
                    "the real media_asset_id returned by prepare_upload."
                )
                return 0

            print("\nSubmitting worlds:generate...")
            generate_resp = submit_generation(session, api_key, payload)
            operation_id = generate_resp["operation_id"]
            submit_cost = generate_resp.get("cost")
            print(f"  operation_id={operation_id}")

        operation_data = poll_operation(session, api_key, operation_id, args.timeout, args.poll_interval)
        result = extract_result(operation_data)

        run_dir = args.output_dir / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        splat_path = run_dir / "scene.spz"
        raw_json_path = run_dir / "raw_response.json"

        print(f"\nDownloading {result['spz_tier']} splat -> {splat_path}")
        download_file(session, result["spz_url"], splat_path)

        run_dir.mkdir(parents=True, exist_ok=True)
        with open(raw_json_path, "w", encoding="utf-8") as f:
            json.dump(operation_data, f, indent=2)

        cost = operation_data.get("cost", submit_cost)

        print("\n" + "=" * 60)
        print("MARBLE TEST — SUCCESS")
        print("=" * 60)
        print(f"world_id:          {result['world_id']}")
        print(f"view in browser:   {result['world_marble_url']}")
        print(f"splat file (local): {splat_path}")
        print(f"raw response JSON: {raw_json_path}")
        if cost is not None:
            print(f"cost/credits:      {cost}")
        else:
            print("cost/credits:      not present in API response")
        print("=" * 60)
        return 0

    except MarbleTestError as e:
        print(f"\n✘ {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
