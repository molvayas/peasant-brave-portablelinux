#!/bin/bash
# Volume processing script called by tar during multi-volume archive creation
#
# This script is called by tar at the end of each volume (BETWEEN volumes, not after the final one)
# 
# Environment variables provided by tar:
#   TAR_ARCHIVE  - current archive name
#   TAR_VOLUME   - next volume number tar is about to start (1-based)
#                  When tar finishes volume N, it calls script with TAR_VOLUME=N+1
#   TAR_FD       - file descriptor to send new volume name to tar
#
# Arguments:
#   $1 - TEMP_DIR: Temporary directory for processing
#   $2 - ARTIFACT_NAME: Base name for artifact uploads
#   $3 - PROCESSED_VOLUMES_FILE: File tracking processed volumes
#   $4 - COMPRESSION_LEVEL: zstd compression level (e.g., 3)
#   $5 - SCRIPTS_DIR: Directory containing upload-volume.js

set -e

# Set locale to C to avoid "Illegal byte sequence" errors on macOS
export LC_ALL=C

TEMP_DIR="$1"
ARTIFACT_NAME="$2"
PROCESSED_VOLUMES_FILE="$3"
COMPRESSION_LEVEL="${4:-3}"
SCRIPTS_DIR="$5"

echo "" >&2
echo "[Volume Script] ============================================" >&2
echo "[Volume Script] Called at: $(date)" >&2
echo "[Volume Script] TAR_VOLUME: ${TAR_VOLUME:-initial}" >&2
echo "[Volume Script] TAR_ARCHIVE: $TAR_ARCHIVE" >&2
echo "[Volume Script] TAR_FD: $TAR_FD" >&2
echo "[Volume Script] ============================================" >&2

# Extract the base name by stripping any -N suffix
BASE_ARCHIVE=$(echo "$TAR_ARCHIVE" | sed 's/-[0-9]*$//')
echo "[Volume Script] Base archive name: $BASE_ARCHIVE" >&2

if [ -z "$TAR_VOLUME" ]; then
    # First call - tar hasn't started yet
    # Return base name (tar will use this as-is for volume 1)
    NEXT_ARCHIVE="${BASE_ARCHIVE}"
    echo "[Volume Script] First call - volume 1 will use base name: $NEXT_ARCHIVE" >&2
else
    # TAR_VOLUME=N means tar is about to start volume N
    # So we need to process volume N-1 (the one that just completed)
    COMPLETED_VOLUME_NUM=$((TAR_VOLUME - 1))
    
    # Volume naming: first volume uses base name, subsequent volumes get suffixes
    if [ $COMPLETED_VOLUME_NUM -eq 1 ]; then
        COMPLETED_VOLUME="${BASE_ARCHIVE}"
    else
        COMPLETED_VOLUME="${BASE_ARCHIVE}-${COMPLETED_VOLUME_NUM}"
    fi
    
    echo "[Volume Script] Processing completed volume ${COMPLETED_VOLUME_NUM}: ${COMPLETED_VOLUME}" >&2
    
    if [ ! -f "$COMPLETED_VOLUME" ]; then
        echo "[Volume Script] ERROR: Completed volume file not found!" >&2
        echo "[Volume Script] Looking for: $COMPLETED_VOLUME" >&2
        ls -lh "$(dirname "$COMPLETED_VOLUME")" >&2 || true
        exit 1
    fi
    
    # Get file size for logging
    SIZE=$(du -h "$COMPLETED_VOLUME" | cut -f1)
    echo "[Volume Script] Volume size: $SIZE" >&2
    
    # Compress with zstd (limit to 2 threads to avoid starving runner)
    echo "[Volume Script] Compressing with zstd (using 2 threads)..." >&2
    COMPRESSED="${COMPLETED_VOLUME}.zst"
    zstd -${COMPRESSION_LEVEL} -T2 --rm "$COMPLETED_VOLUME" -o "$COMPRESSED" 2>&1 | sed 's/^/[zstd] /' >&2
    
    COMPRESSED_SIZE=$(du -h "$COMPRESSED" | cut -f1)
    echo "[Volume Script] Compressed to: $COMPRESSED_SIZE" >&2
    
    # Encrypt with GPG if password is set
    UPLOAD_FILE="$COMPRESSED"
    if [ -n "$ARCHIVE_PASSWORD" ]; then
        echo "[Volume Script] ENCRYPTED: Encrypting with GPG (AES256)..." >&2
        ENCRYPTED="${COMPRESSED}.gpg"
        echo "$ARCHIVE_PASSWORD" | gpg --batch --yes --passphrase-fd 0 --symmetric --cipher-algo AES256 --output "$ENCRYPTED" "$COMPRESSED" 2>&1 | sed 's/^/[gpg] /' >&2
        rm -f "$COMPRESSED"
        UPLOAD_FILE="$ENCRYPTED"
        ENCRYPTED_SIZE=$(du -h "$ENCRYPTED" | cut -f1)
        echo "[Volume Script] Encrypted to: $ENCRYPTED_SIZE" >&2
    fi
    
    # Upload using Node.js script
    echo "[Volume Script] Uploading volume ${COMPLETED_VOLUME_NUM}..." >&2
    VOLUME_NUM=$(printf "%03d" $COMPLETED_VOLUME_NUM)
    
    # Run upload and capture exit code properly
    # Explicitly disable debug mode to suppress ::debug:: messages from upload-artifact
    set +e
    RUNNER_DEBUG="" ACTIONS_STEP_DEBUG="" NODE_PATH="${TEMP_DIR}/node_modules" node "${SCRIPTS_DIR}/upload-volume.js" \
        "$UPLOAD_FILE" \
        "${ARTIFACT_NAME}-vol${VOLUME_NUM}" \
        "$TEMP_DIR" \
        2>&1 | sed 's/^/[upload] /' >&2
    UPLOAD_EXIT=${PIPESTATUS[0]}
    set -e
    
    if [ $UPLOAD_EXIT -ne 0 ]; then
        echo "[Volume Script] ERROR: Upload failed with exit code $UPLOAD_EXIT" >&2
        exit 1
    fi
    
    echo "[Volume Script] Upload successful, cleaning up..." >&2
    rm -f "$UPLOAD_FILE"
    echo "[Volume Script] Volume ${COMPLETED_VOLUME_NUM} processed successfully" >&2
    
    # Track processed volume
    echo "${COMPLETED_VOLUME}" >> "${PROCESSED_VOLUMES_FILE}"
    
    # Generate next volume name
    NEXT_ARCHIVE="${BASE_ARCHIVE}-${TAR_VOLUME}"
    echo "[Volume Script] Next volume (volume ${TAR_VOLUME}) will be: $NEXT_ARCHIVE" >&2
fi

# Send new volume name to tar via TAR_FD
echo "$NEXT_ARCHIVE" >&"$TAR_FD"
echo "[Volume Script] Continuing to next volume..." >&2
echo "[Volume Script] ============================================" >&2
echo "" >&2

exit 0

