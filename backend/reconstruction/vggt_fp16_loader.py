"""
ArticulAIT — VGGT fp16 checkpoint loader (Windows page-file OOM workaround)

Context: facebook/VGGT-1B-Commercial's published checkpoint is fp32 (~5GB
for this 1.0B-param model). VGGT.from_pretrained()'s default loading path
(via huggingface_hub's PyTorchModelHubMixin) ultimately reads that file
through safetensors' PyTorch-framework backend, which memory-maps it using
Windows copy-on-write semantics. Windows requires the OS to reserve page-file
commit-charge capacity for the ENTIRE mapped region up front for a
copy-on-write mapping (unlike a plain shared/read-only mapping, which is
backed directly by the file and needs no extra page-file reservation) - this
is what was actually producing "os error 1455: the paging file is too small
for this operation to complete" on this project's dev machine, regardless of
how large its page file was resized to (D: page file couldn't even be made
to apply at all - it's a BitLocker "Automatic Unlock" volume that isn't
unlocked yet at the point in boot Windows sets up page files - and C: didn't
have enough free disk space for a page file large enough to comfortably
cover a 5GB copy-on-write reservation on top of everything else already
running).

Fix implemented here: avoid the copy-on-write PyTorch-framework safetensors
path entirely.
  1. Convert the (already-downloaded/cached) fp32 checkpoint to fp16 ONCE,
     reading it through safetensors' *numpy* framework backend instead of
     the PyTorch one - numpy access uses a plain read-only mmap with no
     copy-on-write reservation, and by converting one tensor at a time (not
     loading the whole file into a single dict up front) peak memory during
     conversion stays near the size of the single largest tensor, not the
     whole ~5GB file. This halves the on-disk size to ~2.5GB and, more
     importantly, only ever needs to happen once per machine.
  2. Load that fp16 file the same way (numpy framework, tensor-by-tensor,
     each converted to an owned torch.Tensor via torch.from_numpy(...).copy()
     which detaches it from the mmap) and build the state dict manually,
     rather than calling safetensors.torch.load_file(), which is the same
     copy-on-write path that caused the original problem, just against a
     smaller file. This keeps the whole load on the same safe path
     end-to-end instead of only halving the exposure.

If this project is ever run on a machine where a proper Windows page file
exists on a drive that's actually available at early boot (i.e. this whole
problem doesn't exist), this code path is still strictly cheaper than the
default one, so there's no reason to special-case it away.
"""
import os
import json


def _fp16_checkpoint_path(fp32_path: str) -> str:
    return os.path.join(os.path.dirname(fp32_path), "model_fp16.safetensors")


def ensure_fp16_checkpoint(model_name: str, hf_token) -> str:
    """
    Returns the local path to a fp16 safetensors checkpoint for `model_name`,
    converting the cached fp32 checkpoint once if a converted copy doesn't
    already exist next to it. Resolves across candidate HuggingFace repository
    IDs (facebook/VGGT-1B-Commercial and facebook/VGGT-1B).
    """
    from huggingface_hub import hf_hub_download

    candidates = [model_name]
    alt_name = "facebook/VGGT-1B" if "Commercial" in model_name else "facebook/VGGT-1B-Commercial"
    if alt_name not in candidates:
        candidates.append(alt_name)

    fp32_path = None
    for cand in candidates:
        for local_only in [True, False]:
            try:
                fp32_path = hf_hub_download(repo_id=cand, filename="model.safetensors", token=hf_token, local_files_only=local_only)
                break
            except Exception:
                continue
        if fp32_path:
            break

    if not fp32_path:
        raise RuntimeError(f"Could not locate model.safetensors for {model_name} or alternate candidates.")

    fp16_path = _fp16_checkpoint_path(fp32_path)

    if os.path.exists(fp16_path):
        return fp16_path

    import numpy as np
    from safetensors import safe_open
    from safetensors.numpy import save_file as save_file_np

    print(f"[PoseRouter] One-time conversion: {os.path.basename(fp32_path)} (fp32, "
          f"{os.path.getsize(fp32_path) / (1024**3):.2f}GB) -> model_fp16.safetensors. "
          f"This only needs to happen once on this machine; subsequent loads reuse it.")

    converted = {}
    with safe_open(fp32_path, framework="numpy") as f:
        metadata = f.metadata() or {}
        keys = list(f.keys())
        for i, key in enumerate(keys):
            arr = f.get_tensor(key)
            if arr.dtype == np.float32:
                arr = arr.astype(np.float16)
            converted[key] = arr
            if (i + 1) % 50 == 0 or (i + 1) == len(keys):
                print(f"[PoseRouter]   converted {i + 1}/{len(keys)} tensors...")

    tmp_path = fp16_path + ".tmp"
    save_file_np(converted, tmp_path, metadata=metadata)
    os.replace(tmp_path, fp16_path)  # atomic rename: a crash mid-write can't leave a corrupt fp16_path behind
    converted_size = os.path.getsize(fp16_path) / (1024**3)
    print(f"[PoseRouter] fp16 checkpoint written: {fp16_path} ({converted_size:.2f}GB)")
    return fp16_path


def load_vggt_state_dict_fp16(fp16_path: str) -> dict:
    """
    Loads a safetensors checkpoint into a plain state_dict of owned
    torch.Tensor objects, via the numpy framework backend (see module
    docstring for why this avoids the PyTorch framework's copy-on-write
    Windows page-file requirement).
    """
    import torch
    from safetensors import safe_open

    state_dict = {}
    with safe_open(fp16_path, framework="numpy") as f:
        for key in f.keys():
            arr = f.get_tensor(key)
            state_dict[key] = torch.from_numpy(arr.copy())
    return state_dict


def load_vggt_config(model_name: str, hf_token) -> dict:
    """Fetches (from local cache or HF hub) the model's saved __init__ kwargs."""
    from huggingface_hub import hf_hub_download

    candidates = [model_name]
    alt_name = "facebook/VGGT-1B" if "Commercial" in model_name else "facebook/VGGT-1B-Commercial"
    if alt_name not in candidates:
        candidates.append(alt_name)

    config_path = None
    for cand in candidates:
        for local_only in [True, False]:
            try:
                config_path = hf_hub_download(repo_id=cand, filename="config.json", token=hf_token, local_files_only=local_only)
                break
            except Exception:
                continue
        if config_path:
            break

    if not config_path:
        raise RuntimeError(f"Could not locate config.json for {model_name} or alternate candidates.")

    with open(config_path, "r") as cf:
        return json.load(cf)

