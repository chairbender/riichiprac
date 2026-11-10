#!/usr/bin/env python3
"""Download the pre-trained Mortal checkpoint and convert it to Safetensors.

The browser build loads the model through Candle, which wants a flat
``name -> tensor`` Safetensors file with no pickle magic and no wrapper keys.
Mortal training checkpoints (including ``VoidShine/mortal-298k``) are ordinary
PyTorch dictionaries holding one state dict per sub-module plus a pile of
training state, so this script:

1. downloads ``mortal_298k.pth`` from the Hugging Face Hub (or reuses a local copy),
2. extracts the network modules (``mortal`` = ResNet encoder, ``current_dqn`` =
   policy/value head, ``aux_net`` = next-rank auxiliary head) and drops the
   optimizer/scheduler/scaler entries,
3. flattens them into namespaced keys (``mortal.encoder.net.0.weight``,
   ``current_dqn.net.weight``, ...) so Candle can bind them with
   ``VarBuilder::pp("mortal")``,
4. writes ``frontend/public/models/mortal_298k.safetensors`` (served by Vite),
5. and records every key name, shape and dtype in ``scripts/weight_keys.txt``
   so the ``VarBuilder`` paths in ``src/ai/model.rs`` can be matched against
   the real checkpoint.

Setup (torch is only needed to read the ``.pth`` pickle):

    python3 -m venv .venv
    .venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
    .venv/bin/pip install "safetensors>=0.4" huggingface_hub

Usage:

    .venv/bin/python scripts/convert_weights.py

    # explicit paths / smaller f16 payload for a first WASM experiment
    .venv/bin/python scripts/convert_weights.py \\
        --output frontend/public/models/mortal_298k.safetensors \\
        --dtype float16

The script is idempotent: it re-downloads only when the cached ``.pth`` is
missing and only rewrites the Safetensors file when it does not exist (or when
``--force`` is passed).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Iterable

DEFAULT_REPO_ID = "VoidShine/mortal-298k"
DEFAULT_FILENAME = "mortal_298k.pth"

# Checkpoint wrappers seen in the wild. A wrapper is only unwrapped when its
# value is a mapping of tensors.
WRAPPER_KEYS = ("state_dict", "model_state_dict", "model", "net", "module", "network")

# Top-level entries that belong to the optimizer / training loop rather than the
# network. They are skipped (and logged) instead of converted.
TRAINING_PREFIXES = (
    "optim",
    "optimizer",
    "scheduler",
    "lr_scheduler",
    "grad_scaler",
    "scaler",
    "epoch",
    "steps",
    "timestamp",
    "best_perf",
    "config",
)


def repo_root() -> Path:
    """Repository root, resolved from this file's location."""
    return Path(__file__).resolve().parents[1]


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    root = repo_root()
    parser = argparse.ArgumentParser(
        description="Download a Mortal .pth checkpoint and convert it to Safetensors.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--repo-id", default=DEFAULT_REPO_ID, help="Hugging Face model repo.")
    parser.add_argument("--filename", default=DEFAULT_FILENAME, help="Checkpoint file inside the repo.")
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=root / "scripts" / ".weights-cache",
        help="Where the downloaded .pth is kept between runs.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=root / "frontend" / "public" / "models" / "mortal_298k.safetensors",
        help="Destination Safetensors file (Vite serves frontend/public at /).",
    )
    parser.add_argument(
        "--keys-log",
        type=Path,
        default=root / "scripts" / "weight_keys.txt",
        help="Log file listing every converted tensor name, shape and dtype.",
    )
    parser.add_argument(
        "--dtype",
        choices=("float32", "float16"),
        default="float32",
        help="Storage dtype for floating point weights. float16 halves the WASM payload.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-convert even when the output file already exists.",
    )
    return parser.parse_args(argv)


def require(module_name: str, hint: str):
    try:
        return __import__(module_name)
    except ImportError:
        sys.exit(f"Missing Python dependency '{module_name}'.\n  {hint}")


def cached_revision(cache_dir: Path, repo_id: str) -> str | None:
    """Commit hash of the cached Hub snapshot, when huggingface_hub stored one."""
    ref = cache_dir / "hf" / f"models--{repo_id.replace('/', '--')}" / "refs" / "main"
    try:
        return ref.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def download_checkpoint(repo_id: str, filename: str, cache_dir: Path) -> tuple[Path, str | None]:
    """Fetch the checkpoint, preferring huggingface_hub for resume support.

    Returns the local path plus the repo commit hash when it is available.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    local_path = cache_dir / filename
    revision = cached_revision(cache_dir, repo_id)

    try:
        from huggingface_hub import HfApi, hf_hub_download
    except ImportError:
        hf_hub_download = None

    if hf_hub_download is not None:
        if local_path.exists():
            print(f"Reusing cached checkpoint at {local_path}")
            return local_path, revision

        print(f"Downloading {repo_id}/{filename} via huggingface_hub ...")
        try:
            revision = HfApi().model_info(repo_id).sha
        except Exception as err:  # noqa: BLE001 - metadata is a nice-to-have only
            print(f"  (could not read repo revision: {err})")
        # local_dir keeps a plain copy (no symlinks) next to our other artifacts.
        downloaded = Path(
            hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                cache_dir=str(cache_dir / "hf"),
                local_dir=str(cache_dir),
            )
        )
        if downloaded.resolve() != local_path.resolve():
            local_path.write_bytes(downloaded.read_bytes())
        return local_path, revision

    # Fallback: plain HTTP download straight from the Hub.
    import urllib.request

    if local_path.exists():
        print(f"Reusing cached checkpoint at {local_path}")
        return local_path, revision

    url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
    print(f"Downloading {url} ...")
    tmp_path = local_path.with_suffix(local_path.suffix + ".part")
    with urllib.request.urlopen(url) as response, tmp_path.open("wb") as handle:
        total = int(response.headers.get("Content-Length") or 0)
        seen = 0
        while chunk := response.read(1024 * 1024):
            handle.write(chunk)
            seen += len(chunk)
            if total:
                print(f"\r  {seen / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()
    tmp_path.replace(local_path)
    return local_path, revision


def load_checkpoint(path: Path) -> Any:
    require("torch", "pip install torch --index-url https://download.pytorch.org/whl/cpu")
    import torch

    print(f"Loading {path} ...")
    try:
        # weights_only refuses arbitrary pickles; supported since torch 2.0.
        return torch.load(path, map_location="cpu", weights_only=True)
    except Exception as err:  # noqa: BLE001 - older checkpoints embed plain Python objects
        print(f"  weights_only load failed ({err}); retrying with full pickle.")
        print("  NOTE: only do this for checkpoints you trust.")
        return torch.load(path, map_location="cpu", weights_only=False)


def is_tensor(value: Any) -> bool:
    import torch

    return isinstance(value, torch.Tensor)


def looks_like_state_dict(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and bool(value)
        and all(isinstance(k, str) for k in value)
        and any(is_tensor(v) for v in value.values())
    )


def find_state_dict(value: Any, depth: int = 0) -> dict[str, Any] | None:
    """Locate the tensor mapping inside a value, drilling through wrappers."""
    if looks_like_state_dict(value):
        return value
    if isinstance(value, dict) and depth < 4:
        for wrapper in WRAPPER_KEYS:
            if wrapper in value:
                found = find_state_dict(value[wrapper], depth + 1)
                if found is not None:
                    return found
    return None


def extract_modules(checkpoint: Any) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Split a checkpoint into ``module name -> raw state dict``.

    Handles the single-state-dict layout (``{"state_dict": {...}}``) as well as
    Mortal's multi-module layout (``{"mortal": {...}, "current_dqn": {...}}``).
    """
    import torch

    removed: list[str] = []

    if isinstance(checkpoint, torch.nn.Module):
        return {"": checkpoint.state_dict()}, ["<nn.Module>.state_dict()"]

    if not isinstance(checkpoint, dict):
        raise SystemExit(f"Expected a checkpoint dict, got {type(checkpoint).__name__}.")

    modules: dict[str, dict[str, Any]] = {}
    for key, value in checkpoint.items():
        if not isinstance(key, str):
            raise SystemExit(f"Unexpected non-string checkpoint key: {key!r}")

        state_dict = find_state_dict(value)
        if state_dict is None:
            removed.append(f"{key} ({type(value).__name__})")
            continue
        if str(key).lower().startswith(TRAINING_PREFIXES):
            removed.append(f"{key} (training state)")
            continue
        modules[key] = state_dict

    if not modules:
        raise SystemExit("Checkpoint contains no tensor state dicts.")

    # A lone generic wrapper key carries no useful namespace.
    if len(modules) == 1:
        (name, state_dict), = modules.items()
        if name in (*WRAPPER_KEYS, "state_dict", "model_state_dict"):
            removed.append(f"{name} (wrapper)")
            modules = {"": state_dict}

    return modules, removed


def strip_data_parallel_prefix(state_dict: dict[str, Any]) -> tuple[dict[str, Any], int]:
    prefix = "module."
    if state_dict and all(k.startswith(prefix) for k in state_dict):
        return {k[len(prefix):]: v for k, v in state_dict.items()}, len(state_dict)
    return state_dict, 0


def flatten_modules(modules: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Flatten modules into dotted keys: ``mortal.encoder.net.0.weight``."""
    flat: dict[str, Any] = {}
    for name, state_dict in modules.items():
        state_dict, stripped = strip_data_parallel_prefix(state_dict)
        if stripped:
            print(f"  stripped 'module.' prefix from {stripped} tensors in '{name or '<root>'}'")
        prefix = f"{name}." if name else ""
        for key, value in state_dict.items():
            if not is_tensor(value):
                print(f"  skipping non-tensor entry {prefix}{key}")
                continue
            flat[f"{prefix}{key}"] = value
    if not flat:
        raise SystemExit("No tensors left after flattening the checkpoint.")
    return flat


def convert_tensors(tensors: dict[str, Any], dtype_name: str) -> dict[str, Any]:
    import torch

    target_dtype = getattr(torch, dtype_name)
    converted = {}
    for name, tensor in tensors.items():
        tensor = tensor.detach().cpu()
        if tensor.is_floating_point():
            tensor = tensor.to(target_dtype)
        converted[name] = tensor.contiguous()
    return converted


def infer_architecture(tensors: dict[str, Any]) -> dict[str, str]:
    """Shape introspection so Phase 2 has the real numbers, not the guesses."""
    info: dict[str, str] = {}

    conv_weights = [(k, v) for k, v in tensors.items() if v.dim() == 3 and v.is_floating_point()]
    if conv_weights:
        stem_key, stem_weight = max(conv_weights, key=lambda kv: kv[1].shape[1])
        out_channels, in_channels, kernel = stem_weight.shape
        info["input_feature_channels"] = str(in_channels)
        info["stem_conv"] = stem_key
        info["stem_out_channels"] = str(out_channels)
        info["stem_kernel"] = str(kernel)

        # Residual Conv1d layers are square: (channels, channels, kernel).
        residual_convs = [v for _, v in conv_weights if v.shape[0] == v.shape[1]]
        if residual_convs:
            info["residual_channels"] = str(residual_convs[0].shape[0])
            info["residual_conv_count"] = str(len(residual_convs))
            info["residual_blocks"] = str(len(residual_convs) // 2)

        # First conv that shrinks the channel count is the pre-head projection.
        narrowing = [v for _, v in conv_weights if v.shape[0] < v.shape[1]]
        if narrowing:
            info["head_conv_out_channels"] = str(min(v.shape[0] for v in narrowing))

    linear = [(k, v) for k, v in tensors.items() if v.dim() == 2]
    if linear:
        torso_key, torso_weight = max(linear, key=lambda kv: kv[1].shape)
        info["widest_linear"] = torso_key
        info["widest_linear_in_features"] = str(torso_weight.shape[1])
        info["widest_linear_out_features"] = str(torso_weight.shape[0])

    for name in tensors:
        if name.endswith("current_dqn.net.weight") or name.endswith("dqn.net.weight"):
            info["policy_head"] = name
            info["policy_head_total_outputs"] = str(tensors[name].shape[0])
            info["action_space"] = str(tensors[name].shape[0] - 1)  # value + actions
    for name in tensors:
        if name.endswith("aux_net.net.weight"):
            info["aux_head"] = name
            info["aux_outputs"] = str(tensors[name].shape[0])

    info["total_parameters"] = str(sum(v.numel() for v in tensors.values()))
    return info


def describe_layout(tensors: dict[str, Any]) -> str:
    dtype_counts: dict[str, int] = {}
    for tensor in tensors.values():
        label = str(tensor.dtype).replace("torch.", "")
        dtype_counts[label] = dtype_counts.get(label, 0) + 1
    storage_mb = sum(v.numel() * v.element_size() for v in tensors.values()) / 1e6
    return (
        f"{len(tensors)} tensors, {sum(v.numel() for v in tensors.values())} params, "
        f"{storage_mb:.1f} MB, dtypes: " + ", ".join(f"{k}={v}" for k, v in sorted(dtype_counts.items()))
    )


def write_keys_log(
    path: Path,
    tensors: dict[str, Any],
    *,
    repo_id: str,
    source: Path,
    revision: str | None,
    removed: list[str],
    arch: dict[str, str],
) -> None:
    lines = [
        "# Mortal checkpoint weight map (generated by scripts/convert_weights.py)",
        f"# repo      : {repo_id}" + (f" @ {revision}" if revision else ""),
        f"# source    : {source}",
        f"# layout    : {describe_layout(tensors)}",
        "#",
        "# Inferred architecture (match these in src/ai/model.rs):",
    ]
    lines += [f"#   {key} = {value}" for key, value in arch.items()]
    lines.append("#")
    if removed:
        lines.append("# Stripped entries:")
        lines += [f"#   {item}" for item in removed]
        lines.append("#")
    lines.append("# name<TAB>shape<TAB>dtype<TAB>parameters")
    lines.append("#-\t-\t-\t-")

    for name in sorted(tensors):
        tensor = tensors[name]
        shape = str(list(tensor.shape))
        dtype = str(tensor.dtype).replace("torch.", "")
        lines.append(f"{name} \t{shape} \t{dtype}\t{tensor.numel()}")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote weight map ({len(tensors)} tensors) to {path}")


def validate_safetensors(path: Path, expected: dict[str, Any]) -> None:
    from safetensors import safe_open

    with safe_open(str(path), framework="pt", device="cpu") as handle:
        actual = set(handle.keys())
    expected_keys = set(expected)
    if actual != expected_keys:
        missing = sorted(expected_keys - actual)[:5]
        extra = sorted(actual - expected_keys)[:5]
        raise SystemExit(f"Safetensors validation failed. missing={missing} extra={extra}")
    print(f"Validated {len(actual)} tensors in {path} ({path.stat().st_size / 1e6:.1f} MB)")


def extract_config(checkpoint: Any) -> dict[str, Any]:
    if isinstance(checkpoint, dict) and isinstance(checkpoint.get("config"), dict):
        return checkpoint["config"]
    return {}


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    require("torch", "pip install torch --index-url https://download.pytorch.org/whl/cpu")
    require("safetensors", 'pip install "safetensors>=0.4"')

    output: Path = args.output.resolve()
    if output.exists() and not args.force:
        print(f"{output} already exists; pass --force to reconvert.")
        return 0

    checkpoint_path, revision = download_checkpoint(
        args.repo_id, args.filename, args.cache_dir.resolve()
    )
    checkpoint = load_checkpoint(checkpoint_path)
    config = extract_config(checkpoint)
    modules, removed = extract_modules(checkpoint)
    print("Modules: " + ", ".join(f"{name or '<root>'} ({len(sd)} tensors)" for name, sd in modules.items()))

    tensors = flatten_modules(modules)
    tensors = convert_tensors(tensors, args.dtype)
    arch = infer_architecture(tensors)
    print("Architecture: " + ", ".join(f"{k}={v}" for k, v in arch.items()))

    from safetensors.torch import save_file

    metadata = {
        "format": "pt",
        "source": f"{args.repo_id}/{args.filename}",
        "dtype": args.dtype,
    }
    if revision:
        metadata["revision"] = revision
    resnet = config.get("resnet", {}) if isinstance(config, dict) else {}
    if isinstance(resnet, dict):
        for key in ("conv_channels", "num_blocks"):
            if key in resnet:
                metadata[key] = str(resnet[key])
    control = config.get("control", {}) if isinstance(config, dict) else {}
    if isinstance(control, dict) and "version" in control:
        metadata["mortal_version"] = str(control["version"])

    output.parent.mkdir(parents=True, exist_ok=True)
    save_file(tensors, str(output), metadata=metadata)
    print(f"Saved {len(tensors)} tensors to {output} ({output.stat().st_size / 1e6:.1f} MB)")

    write_keys_log(
        args.keys_log.resolve(),
        tensors,
        repo_id=args.repo_id,
        source=checkpoint_path,
        revision=revision,
        removed=removed,
        arch=arch,
    )
    validate_safetensors(output, tensors)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
