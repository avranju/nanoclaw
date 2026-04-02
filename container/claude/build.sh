#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTEXT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE_NAME="nanoclaw-agent-claude"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -f "${SCRIPT_DIR}/Dockerfile" -t "${IMAGE_NAME}:${TAG}" "${CONTEXT_DIR}"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"

