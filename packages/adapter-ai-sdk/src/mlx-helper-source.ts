/**
 * The model-ops Python program, embedded as a string so it ships with the
 * package (no separate file to bundle) and is written into the owned MLX dir
 * and executed by that env's own interpreter (which has mlx-lm's pinned
 * `huggingface_hub`). It runs with `HF_HOME` pointed at the owned cache, so
 * discovery and downloads use the exact same weights the server later loads.
 *
 * It speaks NDJSON on stdout (one JSON object per line) so the TypeScript side
 * can render live status; tqdm's own bars go to stderr and are ignored.
 *
 * Subcommands:
 *   scan                 emit one {type:"model"} per usable local MLX repo,
 *                        then {type:"scan_done"}.
 *   download <repo>      snapshot_download <repo> into the owned cache, emitting
 *                        {type:"file"} / {type:"progress"} as bytes arrive and
 *                        {type:"download_done"} at the end. Resumable for free.
 */
export const MLX_HELPER_PY = String.raw`
import json
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def cmd_scan():
    try:
        from huggingface_hub import scan_cache_dir
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": "huggingface_hub unavailable: %s" % exc})
        return 1
    try:
        info = scan_cache_dir()
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": str(exc)})
        return 1

    # A usable MLX repo has weights plus a config. Accept both multi-shard
    # (model.safetensors.index.json) and single-file (model.safetensors)
    # layouts; mlx-lm's own server check misses the single-file case.
    weight_markers = ("model.safetensors.index.json", "model.safetensors")
    count = 0
    for repo in info.repos:
        if repo.repo_type != "model":
            continue
        refs = getattr(repo, "refs", {}) or {}
        if "main" not in refs:
            continue
        names = {f.file_path.name for f in refs["main"].files}
        if "config.json" not in names:
            continue
        if not any(marker in names for marker in weight_markers):
            continue
        last_modified = getattr(repo, "last_modified", None)
        emit(
            {
                "type": "model",
                "repo": repo.repo_id,
                "sizeBytes": int(getattr(repo, "size_on_disk", 0) or 0),
                "files": len(names),
                "lastModified": float(last_modified) if last_modified else None,
            }
        )
        count += 1
    emit({"type": "scan_done", "count": count})
    return 0


# Mirror mlx-lm's allow_patterns so we fetch exactly the weights/config/
# tokenizer files the server needs and skip PyTorch/GGUF duplicates.
ALLOW_PATTERNS = [
    "*.json",
    "model*.safetensors",
    "*.py",
    "tokenizer.model",
    "*.tiktoken",
    "tiktoken.model",
    "*.txt",
    "*.jsonl",
    "*.jinja",
]


def cmd_download(repo):
    # Progress is reported through snapshot_download's public tqdm_class hook.
    # Internally snapshot_download builds its single aggregate byte bar as
    # tqdm_class(...), and every backend (classic HTTP and the Xet path, which
    # mlx-community weights use) funnels its byte updates into that bar. So a
    # tqdm subclass that emits NDJSON instead of drawing gives accurate,
    # backend-agnostic, resume-safe progress without disabling Xet or touching
    # any private internals. Overriding display() is tqdm's documented hook.
    try:
        from huggingface_hub import snapshot_download
        from tqdm.auto import tqdm as base_tqdm
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": "huggingface_hub unavailable: %s" % exc})
        return 1

    state = {"last": 0.0}

    def emit_progress(bar, force=False):
        now = time.time()
        if not force and now - state["last"] < 0.15:
            return
        state["last"] = now
        total = getattr(bar, "total", None)
        emit(
            {
                "type": "progress",
                "downloaded": int(getattr(bar, "n", 0) or 0),
                "total": int(total) if total else None,
            }
        )

    class NdjsonTqdm(base_tqdm):
        def display(self, *args, **kwargs):
            # snapshot_download also builds an outer files counter (unit "it");
            # only the byte bar (unit "B") is the download progress we report.
            if getattr(self, "unit", None) == "B":
                emit_progress(self)
            return True  # suppress tqdm's own terminal rendering

    emit({"type": "file", "name": repo})
    try:
        path = snapshot_download(repo, allow_patterns=ALLOW_PATTERNS, tqdm_class=NdjsonTqdm)
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": str(exc)})
        return 1
    emit({"type": "download_done", "path": str(path)})
    return 0


def main(argv):
    if len(argv) < 2:
        emit({"type": "error", "message": "usage: mlx-helper.py <scan|download> [repo]"})
        return 2
    command = argv[1]
    if command == "scan":
        return cmd_scan()
    if command == "download":
        if len(argv) < 3:
            emit({"type": "error", "message": "download requires a repo id"})
            return 2
        return cmd_download(argv[2])
    emit({"type": "error", "message": "unknown command: %s" % command})
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;
