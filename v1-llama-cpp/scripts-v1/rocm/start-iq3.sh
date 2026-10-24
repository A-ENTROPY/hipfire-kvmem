#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 2 || $# -gt 3 ]]; then
    echo "Usage: $0 MODEL.gguf MMPROJ.gguf [ROCm0]" >&2
    exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build="${BUILD_DIR:-${root}}"
if [[ ! -x "${build}/bin/llama-kvmem-server" && -z "${BUILD_DIR:-}" ]]; then
    build="${root}/build-hip-linux"
fi
model="$1"; mmproj="$2"; gpu="${3:-ROCm0}"
port=18200
ui="${build}/share/kvmem/ui"
[[ "$gpu" =~ ^ROCm[0-9]+$ ]] || { echo 'Select a device from --list-devices (for example ROCm0).' >&2; exit 2; }
for file in "$model" "$mmproj" "${build}/bin/llama-kvmem-server" "${ui}/index.html"; do
    [[ -f "$file" ]] || { echo "Missing file: $file" >&2; exit 2; }
done
export LD_LIBRARY_PATH="${build}/lib:${build}/bin:${ROCM_PATH:-/opt/rocm}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
if grep -qi microsoft /proc/sys/kernel/osrelease; then
    export HSA_ENABLE_DXG_DETECTION="${HSA_ENABLE_DXG_DETECTION:-1}"
fi
echo "IQ3 / HIP / ${gpu}: http://127.0.0.1:${port}/ (Ctrl+C to stop)"
exec "${build}/bin/llama-kvmem-server" \
    -m "$model" --mmproj "$mmproj" --no-mmproj-offload \
    --device "$gpu" -ngl 99 --load-mode auto \
    --host 127.0.0.1 --port "$port" --webui --ui-dir "$ui" \
    -c 262144 -b 512 -n 16384 \
    --kvmem --kvmem-budget 36864 --kvmem-gen-reserve 16384 \
    --kvmem-block-tokens 128 --kvmem-query-policy user --kv-dtype q8_0 \
    --spec-type draft-mtp --spec-draft-n-max 2 --spec-kv-dtype f16 \
    --kvmem-mtp-state replay --image-max-tokens 512 \
    --enable-thinking --reasoning-budget 4096
