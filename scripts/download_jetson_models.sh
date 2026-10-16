#!/bin/sh
set -eu

model_root=${1:-models}

download() {
    expected_sha=$1
    url=$2
    destination=$3
    partial="${destination}.part"

    mkdir -p "$(dirname "$destination")"
    if [ -f "$destination" ]; then
        if printf '%s  %s\n' "$expected_sha" "$destination" | sha256sum --check --status; then
            printf 'verified %s\n' "$destination"
            return
        fi
        if [ -f "$partial" ]; then
            printf 'both invalid final and partial files exist for %s\n' "$destination" >&2
            return 1
        fi
        mv "$destination" "$partial"
        printf 'resuming incomplete %s\n' "$destination"
    fi

    curl --fail --location --retry 8 --continue-at - "$url" --output "$partial"
    printf '%s  %s\n' "$expected_sha" "$partial" | sha256sum --check --status
    mv "$partial" "$destination"
    printf 'downloaded and verified %s\n' "$destination"
}

download \
    0155f4523b0c2e3cb541abdc4b5b1845e7b74af9ae8ae8dde9f4d09783371c86 \
    'https://huggingface.co/second-state/Qwen3-30B-A3B-Instruct-2507-GGUF/resolve/main/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf?download=true' \
    "$model_root/llm/qwen3-30b-a3b-instruct-2507-q4_k_m.gguf"

# Same base model with Heretic abliteration (refusal directions removed).
# Keep stock and heretic side-by-side so JARVIS_LLM_VARIANT can flip either way.
download \
    19c2dc3e89a461afc9a3fb082b76a99e59049c9bbec5bb1b5bdb159f5c59ec6d \
    'https://huggingface.co/mradermacher/Qwen3-30B-A3B-Instruct-2507-Heretic-GGUF/resolve/main/Qwen3-30B-A3B-Instruct-2507-Heretic.Q4_K_M.gguf?download=true' \
    "$model_root/llm/qwen3-30b-a3b-instruct-2507-heretic-q4_k_m.gguf"

download \
    66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a \
    'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3VL-4B-Instruct-Q4_K_M.gguf?download=true' \
    "$model_root/vision/Qwen3VL-4B-Instruct-Q4_K_M.gguf"

download \
    30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d \
    'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf?download=true' \
    "$model_root/vision/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf"

download \
    7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5 \
    'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx' \
    "$model_root/kokoro/kokoro-v1.0.onnx"

download \
    bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d \
    'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin' \
    "$model_root/kokoro/voices-v1.0.bin"
