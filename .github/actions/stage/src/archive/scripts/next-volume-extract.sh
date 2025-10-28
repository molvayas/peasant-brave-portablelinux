#!/bin/bash
# Volume processing script called by tar during multi-volume archive extraction
#
# This script is called by tar when it needs the next volume
#
# Environment variables provided by tar:
#   TAR_ARCHIVE  - current archive name
#   TAR_VOLUME   - volume number being requested (1-based)
#   TAR_FD       - file descriptor to send volume path to tar
#
# Arguments:
#   $1 - BASE_NAME: Base name of the archive
#   $2 - VOLUMES_DIR: Directory where volumes are downloaded
#   $3 - VOLUME_COUNT: Total number of volumes
#   $4 - ARTIFACT_BASE: Base name for artifact downloads
#   $5 - TEMP_DIR: Temporary directory for scripts

set -e

BASE_NAME="$1"
VOLUMES_DIR="$2"
VOLUME_COUNT="$3"
ARTIFACT_BASE="$4"
TEMP_DIR="$5"

if [ -z "$TAR_VOLUME" ]; then
    # First call - return volume 1 path
    VOLUME_NUM=1
    VOLUME_FILE="${VOLUMES_DIR}/${BASE_NAME}.tar"
    echo "[Extract] Returning volume 1: $VOLUME_FILE" >&2
else
    # TAR_VOLUME = N means tar wants volume N
    VOLUME_NUM=$TAR_VOLUME
    
    # Check if this volume number is beyond what we have
    if [ $VOLUME_NUM -gt $VOLUME_COUNT ]; then
        echo "[Extract] ERROR: Tar requested volume ${VOLUME_NUM} but only ${VOLUME_COUNT} volumes exist" >&2
        echo "" >&"$TAR_FD"
        exit 0
    fi
    
    # Determine the volume filename
    if [ $VOLUME_NUM -eq 1 ]; then
        VOLUME_FILE="${VOLUMES_DIR}/${BASE_NAME}.tar"
    else
        VOLUME_FILE="${VOLUMES_DIR}/${BASE_NAME}.tar-${VOLUME_NUM}"
    fi
    
    # Delete the PREVIOUS volume to save space
    if [ $VOLUME_NUM -gt 1 ]; then
        if [ $VOLUME_NUM -eq 2 ]; then
            PREV_VOLUME_FILE="${VOLUMES_DIR}/${BASE_NAME}.tar"
        else
            PREV_NUM=$((VOLUME_NUM - 1))
            PREV_VOLUME_FILE="${VOLUMES_DIR}/${BASE_NAME}.tar-${PREV_NUM}"
        fi
        
        if [ -f "$PREV_VOLUME_FILE" ]; then
            echo "[Extract] Deleting previous volume: ${PREV_VOLUME_FILE}" >&2
            rm -f "$PREV_VOLUME_FILE"
        fi
    fi
    
    # Download the requested volume if not already present
    if [ ! -f "$VOLUME_FILE" ]; then
        echo "[Extract] Downloading volume ${VOLUME_NUM}..." >&2
        
        ARTIFACT_NAME="${ARTIFACT_BASE}-vol$(printf '%03d' $VOLUME_NUM)"
        
        NODE_PATH="${TEMP_DIR}/node_modules" node "${TEMP_DIR}/../scripts/download-volume.js" \
            "$VOLUME_NUM" \
            "$ARTIFACT_NAME" \
            "$VOLUME_FILE" \
            "$TEMP_DIR" \
            >&2
        
        if [ $? -ne 0 ]; then
            echo "[Extract] ERROR: Failed to download volume ${VOLUME_NUM}" >&2
            exit 1
        fi
    fi
    
    echo "[Extract] Returning volume ${VOLUME_NUM}: $VOLUME_FILE" >&2
fi

# Return volume path to tar
echo "$VOLUME_FILE" >&"$TAR_FD"

