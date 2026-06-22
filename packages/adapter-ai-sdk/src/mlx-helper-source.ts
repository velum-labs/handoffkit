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


def cmd_download(repo):
    try:
        from huggingface_hub import snapshot_download
        import huggingface_hub.file_download as file_download
        from huggingface_hub.utils import tqdm as hf_tqdm
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": "huggingface_hub unavailable: %s" % exc})
        return 1

    # Mirror mlx-lm's allow_patterns so we fetch exactly the weights/config/
    # tokenizer files the server needs and skip PyTorch/GGUF duplicates.
    allow_patterns = [
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

    state = {"bars": {}, "last": 0.0}

    def flush(force=False):
        now = time.time()
        if not force and now - state["last"] < 0.2:
            return
        state["last"] = now
        downloaded = sum(bar["n"] for bar in state["bars"].values())
        total = sum(bar["total"] for bar in state["bars"].values() if bar["total"])
        emit(
            {
                "type": "progress",
                "downloaded": int(downloaded),
                "total": int(total) if total else None,
            }
        )

    # The byte-level progress lives in the per-file bars hf_hub_download builds
    # via huggingface_hub.file_download.tqdm. Subclass that (so the HF disable
    # env is still honored) and aggregate across every live bar.
    class ProgressTqdm(hf_tqdm):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._key = id(self)
            state["bars"][self._key] = {"n": 0, "total": self.total or 0}
            desc = (self.desc or "").strip()
            if desc:
                emit({"type": "file", "name": desc})
            flush()

        def update(self, n=1):
            result = super().update(n)
            bar = state["bars"].get(self._key)
            if bar is not None:
                bar["n"] = self.n
                bar["total"] = self.total or bar["total"]
            flush()
            return result

        def close(self):
            bar = state["bars"].get(self._key)
            if bar is not None and bar["total"]:
                bar["n"] = bar["total"]
            flush(force=True)
            return super().close()

    file_download.tqdm = ProgressTqdm

    try:
        path = snapshot_download(repo, allow_patterns=allow_patterns)
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": str(exc)})
        return 1
    flush(force=True)
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
