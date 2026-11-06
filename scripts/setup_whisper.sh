#!/usr/bin/env bash
set -euo pipefail

WHISPER_VERSION="v1.9.1"
WHISPER_COMMIT="f049fff95a089aa9969deb009cdd4892b3e74916"
MODEL_NAME="large-v3"
MODEL_SHA256="64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin"

CACHE_ROOT="${WHISPER_CPP_HOME:-${XDG_CACHE_HOME:-${HOME}/.cache}/whisper.cpp}"
SOURCE_DIR="${CACHE_ROOT}/sources/${WHISPER_VERSION}"
MODEL_DIR="${CACHE_ROOT}/models"
MODEL_PATH="${MODEL_DIR}/ggml-${MODEL_NAME}.bin"
BACKEND="auto"

usage() {
    cat <<'EOF'
Usage: setup_whisper.sh [--backend auto|cpu|vulkan|hip|metal]

Builds whisper.cpp v1.9.1 and downloads the multilingual large-v3 model.
Files are stored under ~/.cache/whisper.cpp by default.

Environment:
  WHISPER_CPP_HOME  Override the whisper.cpp cache directory.
EOF
}

fail() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

detect_hip_target() {
    local line
    while IFS= read -r line; do
        if [[ "${line}" =~ Name:[[:space:]]+(gfx[[:alnum:]]+) ]]; then
            printf '%s\n' "${BASH_REMATCH[1]}"
            return 0
        fi
    done < <(rocminfo 2>/dev/null)
    return 1
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    else
        fail "sha256sum or shasum is required to verify the model"
    fi
}

download_file() {
    local url="$1"
    local destination="$2"
    if command -v curl >/dev/null 2>&1; then
        curl --fail --location --retry 3 --output "${destination}" "${url}"
    elif command -v wget >/dev/null 2>&1; then
        wget --tries=3 --output-document="${destination}" "${url}"
    else
        fail "curl or wget is required to download the model"
    fi
}

has_hardware_vulkan_device() {
    local line
    while IFS= read -r line; do
        if [[ "${line}" =~ ggml_vulkan:[[:space:]]+[0-9]+[[:space:]]+= ]] && \
           [[ "${line}" != *"llvmpipe"* && "${line}" != *"lavapipe"* ]]; then
            return 0
        fi
    done <<< "$1"
    return 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend)
            [[ $# -ge 2 ]] || fail "--backend requires a value"
            BACKEND="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
done

REQUESTED_BACKEND="${BACKEND}"

case "${BACKEND}" in
    auto|cpu|vulkan|hip|metal) ;;
    *) fail "unsupported backend '${BACKEND}'; expected auto, cpu, vulkan, hip or metal" ;;
esac

require_command git
require_command cmake
require_command ffmpeg

if ! command -v c++ >/dev/null 2>&1 && ! command -v clang++ >/dev/null 2>&1; then
    fail "a C++ compiler is required (c++ or clang++)"
fi
CXX_COMMAND="$(command -v c++ || command -v clang++)"

OS_NAME="$(uname -s)"
HIP_TARGET=""

if [[ "${BACKEND}" == "auto" ]]; then
    if [[ "${OS_NAME}" == "Darwin" ]]; then
        BACKEND="metal"
    elif [[ "${OS_NAME}" == "Linux" ]] && command -v glslc >/dev/null 2>&1; then
        BACKEND="vulkan"
    else
        BACKEND="cpu"
        if [[ "${OS_NAME}" == "Linux" ]]; then
            printf '%s\n' \
                "Vulkan build tools were not found; using CPU." \
                "On Ubuntu install: sudo apt install libvulkan-dev glslc spirv-headers vulkan-tools" >&2
        fi
    fi
fi

if [[ "${REQUESTED_BACKEND}" == "auto" && "${BACKEND}" != "cpu" ]]; then
    if "${BASH_SOURCE[0]}" --backend "${BACKEND}"; then
        exit 0
    fi
    printf 'warning: %s setup failed; falling back to CPU\n' "${BACKEND}" >&2
    exec "${BASH_SOURCE[0]}" --backend cpu
fi

if [[ "${BACKEND}" == "metal" && "${OS_NAME}" != "Darwin" ]]; then
    fail "the metal backend is supported only on macOS"
fi

if [[ "${BACKEND}" == "hip" ]]; then
    require_command hipcc
    require_command hipconfig
    require_command rocminfo
    if [[ -z "${HIP_TARGET}" ]]; then
        HIP_TARGET="$(detect_hip_target || true)"
    fi
    [[ -n "${HIP_TARGET}" ]] || fail "could not detect an AMD gfx target with rocminfo"
fi

if [[ "${BACKEND}" == "vulkan" ]]; then
    require_command glslc
fi

if [[ "${BACKEND}" != "cpu" ]]; then
    CPU_BIN="${CACHE_ROOT}/builds/${WHISPER_VERSION}/cpu/bin/whisper-cli"
    CPU_BIN_RELEASE="${CACHE_ROOT}/builds/${WHISPER_VERSION}/cpu/bin/Release/whisper-cli"
    if [[ ! -x "${CPU_BIN}" && ! -x "${CPU_BIN_RELEASE}" ]]; then
        printf 'Building the CPU fallback before %s.\n' "${BACKEND}"
        "${BASH_SOURCE[0]}" --backend cpu
    fi
fi

BUILD_DIR="${CACHE_ROOT}/builds/${WHISPER_VERSION}/${BACKEND}"

mkdir -p "$(dirname "${SOURCE_DIR}")" "${MODEL_DIR}" "${BUILD_DIR}"

if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
    if [[ -e "${SOURCE_DIR}" ]]; then
        fail "source path exists but is not a Git checkout: ${SOURCE_DIR}"
    fi
    git clone --branch "${WHISPER_VERSION}" --depth 1 \
        https://github.com/ggml-org/whisper.cpp.git "${SOURCE_DIR}"
fi

SOURCE_TAG="$(git -C "${SOURCE_DIR}" describe --tags --exact-match 2>/dev/null || true)"
[[ "${SOURCE_TAG}" == "${WHISPER_VERSION}" ]] || \
    fail "expected ${WHISPER_VERSION} in ${SOURCE_DIR}, found '${SOURCE_TAG:-unknown revision}'"
SOURCE_COMMIT="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"
[[ "${SOURCE_COMMIT}" == "${WHISPER_COMMIT}" ]] || \
    fail "expected commit ${WHISPER_COMMIT} in ${SOURCE_DIR}, found ${SOURCE_COMMIT}"
SOURCE_CHANGES="$(git -C "${SOURCE_DIR}" status --short --untracked-files=no)"
[[ -z "${SOURCE_CHANGES}" ]] || fail "whisper.cpp source checkout has local changes: ${SOURCE_DIR}"

CMAKE_ARGS=(
    -S "${SOURCE_DIR}"
    -B "${BUILD_DIR}"
    -DCMAKE_BUILD_TYPE=Release
    -DWHISPER_BUILD_TESTS=OFF
    -DWHISPER_BUILD_SERVER=OFF
)

case "${BACKEND}" in
    hip)
        HIP_ROOT="$(hipconfig --path 2>/dev/null || true)"
        [[ -n "${HIP_ROOT}" ]] || fail "hipconfig did not report the HIP installation path"
        HIP_CMAKE_DIR="${HIP_ROOT}/lib/cmake/hip"
        HIP_MULTIARCH="$(${CXX_COMMAND} -print-multiarch 2>/dev/null || true)"
        if [[ -n "${HIP_MULTIARCH}" && -f "${HIP_ROOT}/lib/${HIP_MULTIARCH}/cmake/hip/hip-config.cmake" ]]; then
            HIP_CMAKE_DIR="${HIP_ROOT}/lib/${HIP_MULTIARCH}/cmake/hip"
        fi
        [[ -f "${HIP_CMAKE_DIR}/hip-config.cmake" ]] || \
            fail "hip-config.cmake was not found under ${HIP_ROOT}"
        CMAKE_ARGS+=(
            -DGGML_HIP=ON
            -DGGML_VULKAN=OFF
            "-DAMDGPU_TARGETS=${HIP_TARGET}"
            "-DCMAKE_HIP_COMPILER_ROCM_ROOT=${HIP_ROOT}"
            "-Dhip_DIR=${HIP_CMAKE_DIR}"
        )
        ;;
    metal)
        CMAKE_ARGS+=(
            -DGGML_METAL=ON
            -DGGML_METAL_EMBED_LIBRARY=ON
            -DGGML_VULKAN=OFF
        )
        ;;
    vulkan)
        CMAKE_ARGS+=(
            -DGGML_HIP=OFF
            -DGGML_METAL=OFF
            -DGGML_VULKAN=ON
        )
        if [[ -n "${VULKAN_SDK:-}" ]]; then
            CMAKE_ARGS+=("-DCMAKE_PREFIX_PATH=${VULKAN_SDK}")
        fi
        ;;
    cpu)
        CMAKE_ARGS+=(
            -DGGML_HIP=OFF
            -DGGML_METAL=OFF
            -DGGML_VULKAN=OFF
        )
        ;;
esac

if command -v getconf >/dev/null 2>&1; then
    BUILD_JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
elif command -v sysctl >/dev/null 2>&1; then
    BUILD_JOBS="$(sysctl -n hw.ncpu 2>/dev/null || true)"
else
    BUILD_JOBS=""
fi
BUILD_JOBS="${BUILD_JOBS:-4}"

printf 'Building whisper.cpp %s with backend %s' "${WHISPER_VERSION}" "${BACKEND}"
if [[ -n "${HIP_TARGET}" ]]; then
    printf ' (%s)' "${HIP_TARGET}"
fi
printf '\n'

cmake "${CMAKE_ARGS[@]}"
cmake --build "${BUILD_DIR}" --config Release --parallel "${BUILD_JOBS}"

WHISPER_BIN="${BUILD_DIR}/bin/whisper-cli"
if [[ ! -x "${WHISPER_BIN}" ]]; then
    WHISPER_BIN="${BUILD_DIR}/bin/Release/whisper-cli"
fi
[[ -x "${WHISPER_BIN}" ]] || fail "whisper-cli was not produced in ${BUILD_DIR}/bin"

if [[ "${BACKEND}" == "vulkan" ]]; then
    if command -v timeout >/dev/null 2>&1; then
        VULKAN_PROBE="$(timeout 30 "${WHISPER_BIN}" --version 2>&1)" || \
            fail "the Vulkan binary failed or timed out during its device probe"
    else
        VULKAN_PROBE="$("${WHISPER_BIN}" --version 2>&1)" || \
            fail "the Vulkan binary failed its device probe"
    fi
    printf '%s\n' "${VULKAN_PROBE}"
    [[ "${VULKAN_PROBE}" == *"ggml_vulkan: Found"* ]] || \
        fail "the Vulkan binary did not detect a Vulkan device"
    has_hardware_vulkan_device "${VULKAN_PROBE}" || \
        fail "only a software Vulkan device was detected; refusing to activate it"
fi

if [[ -f "${MODEL_PATH}" ]]; then
    CURRENT_SHA256="$(sha256_file "${MODEL_PATH}")"
else
    CURRENT_SHA256=""
fi

if [[ "${CURRENT_SHA256}" != "${MODEL_SHA256}" ]]; then
    MODEL_PART="${MODEL_PATH}.part"
    trap 'rm -f "${MODEL_PART:-}"' EXIT
    printf 'Downloading %s model to %s\n' "${MODEL_NAME}" "${MODEL_PATH}"
    download_file "${MODEL_URL}" "${MODEL_PART}"
    DOWNLOADED_SHA256="$(sha256_file "${MODEL_PART}")"
    [[ "${DOWNLOADED_SHA256}" == "${MODEL_SHA256}" ]] || \
        fail "model checksum mismatch: expected ${MODEL_SHA256}, got ${DOWNLOADED_SHA256}"
    mv "${MODEL_PART}" "${MODEL_PATH}"
    trap - EXIT
fi

ACTIVE_BACKEND_PART="${CACHE_ROOT}/active-backend.part.$$"
printf '%s\n' "${BACKEND}" > "${ACTIVE_BACKEND_PART}"
mv "${ACTIVE_BACKEND_PART}" "${CACHE_ROOT}/active-backend"

printf '\nLocal Whisper is ready.\n'
printf 'Binary: %s\n' "${WHISPER_BIN}"
printf 'Model:  %s\n' "${MODEL_PATH}"
printf 'Backend: %s\n' "${BACKEND}"
