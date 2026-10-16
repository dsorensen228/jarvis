#!/bin/sh
set -eu

# Resolve which Qwen3-30B-A3B Instruct 2507 GGUF to serve.
# JARVIS_LLM_VARIANT=heretic|stock selects the experiment vs stock weights.
# Explicit LLM_MODEL_PATH or LLM_MODEL_FILE still win when set.
resolve_llm_model_path() {
  if [ -n "${LLM_MODEL_PATH:-}" ]; then
    printf '%s\n' "$LLM_MODEL_PATH"
    return 0
  fi
  if [ -n "${LLM_MODEL_FILE:-}" ]; then
    printf '%s\n' "/models/$LLM_MODEL_FILE"
    return 0
  fi

  variant="${JARVIS_LLM_VARIANT:-heretic}"
  case "$variant" in
    heretic)
      printf '%s\n' "/models/qwen3-30b-a3b-instruct-2507-heretic-q4_k_m.gguf"
      ;;
    stock)
      printf '%s\n' "/models/qwen3-30b-a3b-instruct-2507-q4_k_m.gguf"
      ;;
    *)
      printf 'Unknown JARVIS_LLM_VARIANT=%s (expected heretic or stock)\n' "$variant" >&2
      return 1
      ;;
  esac
}

LLM_MODEL_PATH="$(resolve_llm_model_path)"
: "${LLM_CONTEXT_SIZE:=32768}"
: "${LLM_HOST:=0.0.0.0}"
: "${LLM_PORT:=8080}"

printf 'llm entrypoint: model=%s variant=%s\n' \
  "$LLM_MODEL_PATH" "${JARVIS_LLM_VARIANT:-heretic}"

set -- llama-server \
  --model "$LLM_MODEL_PATH" \
  --host "$LLM_HOST" \
  --port "$LLM_PORT" \
  --ctx-size "$LLM_CONTEXT_SIZE" \
  --parallel 1 \
  --n-gpu-layers 999 \
  --flash-attn off \
  --cache-type-k q8_0 \
  --cache-type-v f16 \
  --jinja

if [ -n "${LLM_MMPROJ_PATH:-}" ]; then
  set -- "$@" --mmproj "$LLM_MMPROJ_PATH"
fi
if [ -n "${LLM_IMAGE_MAX_TOKENS:-}" ]; then
  set -- "$@" --image-max-tokens "$LLM_IMAGE_MAX_TOKENS"
fi

exec "$@"
