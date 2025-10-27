# Multi-Volume Tar Optimization

## Overview

The build workflow has been optimized to use multi-volume tar archives with streaming compression and upload. This significantly reduces disk space usage during the archiving and extraction phases of the Brave browser build process.

## Problem Solved

Previously, the workflow would:
1. Complete the build (uses ~80GB)
2. Create a single large tar archive (~40GB)
3. Compress it (~20GB)
4. Upload it

This required having **at least 120GB of disk space** simultaneously (80GB build + 40GB tar), which often exceeded GitHub Actions runner capacity.

## New Approach

### Archiving (Creating Checkpoint)

The new multi-volume approach:

1. **Creates 5GB tar volumes** using `tar -cM -L` (multi-volume mode)
2. **Removes source files** as they're added (`--remove-files` flag)
3. **Streams the process**:
   - Volume 1 is created (5GB)
   - Immediately compressed with zstd (~2.5GB)
   - Uploaded to GitHub Artifacts
   - Both uncompressed and compressed files deleted
   - Repeat for volume 2, 3, etc.

**Disk space savings**: Only need ~10GB extra (5GB volume + 2.5GB compressed) instead of 60GB+

### Key Features

- **`--remove-files`**: Source files are deleted after being added to archive, freeing space continuously
- **Multi-volume (-cM -L)**: Creates manageable 5GB chunks instead of one huge file
- **Streaming workflow**: Compress → Upload → Delete happens for each volume independently
- **Manifest system**: JSON manifest tracks all volumes for reliable extraction

### Extraction (Restoring Checkpoint)

The extraction process is equally optimized:

1. Download manifest (lists all volumes)
2. For each volume:
   - Download compressed volume (~2.5GB)
   - Decompress with zstd (5GB)
   - Extract to final location
   - Delete compressed file
   - Delete decompressed tar file
   - Move to next volume

**Disk space savings**: Only need ~10GB for extraction at any time, instead of downloading entire archive first

## Implementation Details

### Archive Creation Function

```javascript
async function createMultiVolumeArchive(archiveBaseName, workDir, paths, artifact, artifactName)
```

**Process:**
1. Creates a bash script (`next-volume.sh`) to handle volume transitions
2. Starts `tar` with multi-volume flags (`-cM -L <blocks> -F <script>`)
3. Monitors temp directory for completed volumes
4. For each completed volume:
   - Compresses with `zstd -19 -T0` (high compression, multi-threaded)
   - Uploads as `build-artifact-vol001`, `build-artifact-vol002`, etc.
   - Deletes local files
5. Creates and uploads manifest JSON with volume list

### Extraction Function

```javascript
async function extractMultiVolumeArchive(workDir, artifact, artifactName)
```

**Process:**
1. Downloads and reads manifest
2. For each volume in sequence:
   - Downloads compressed artifact
   - Decompresses with `zstd -d`
   - Extracts with `tar -xf`
   - Cleans up temporary files
3. Reconstructs complete build state

## Tar Command Details

### Archive Creation

```bash
tar -cM \                    # Create multi-volume archive
    -L 10485760 \            # 5GB per volume (in 512-byte blocks)
    -F next-volume.sh \      # Script to call for next volume
    -f build-state.tar \     # Base archive name
    -H posix \               # POSIX format for compatibility
    --atime-preserve \       # Preserve access times
    --remove-files \         # DELETE files after archiving (key optimization!)
    -C /workdir \            # Change to work directory
    src build-stage.txt      # Paths to archive
```

### Volume Script (`next-volume.sh`)

This script is called by tar when it needs to switch volumes:
- Generates next volume filename (archive.tar → archive.tar-1 → archive.tar-2)
- Creates `.complete` marker for Node.js to detect finished volumes
- Returns new volume name to tar

### Extraction

```bash
# For each volume:
zstd -d --rm volume.tar.zst -o volume.tar    # Decompress
tar -xf volume.tar -C /workdir               # Extract
rm volume.tar                                # Cleanup
```

## Manifest Format

```json
{
  "baseName": "build-state",
  "volumeCount": 3,
  "volumes": [
    "build-artifact-vol001",
    "build-artifact-vol002",
    "build-artifact-vol003"
  ],
  "timestamp": "2025-10-27T10:30:00.000Z",
  "volumeSize": "5GB"
}
```

## Benefits

1. **Disk Space Efficiency**:
   - Old: Need 60-80GB extra during archiving
   - New: Need only ~10GB extra during archiving

2. **Resumability**:
   - If upload fails, only need to re-upload failed volume
   - Partial archives can be handled gracefully

3. **Parallelization Potential**:
   - Could upload volumes in parallel in future
   - Could download volumes in parallel in future

4. **Progress Visibility**:
   - Clear progress as each volume completes
   - Easy to monitor disk usage per volume

## Performance Considerations

### Compression

- Uses `zstd -19 -T0`: Maximum compression, all CPU cores
- ~50% compression ratio for build artifacts
- Multi-threaded compression is fast (~200-300 MB/s)

### Network

- 5GB volumes are well-suited for GitHub Actions artifact system
- Better than larger volumes for reliability and resumability
- Upload time: ~2-5 minutes per volume depending on network
- More volumes means better progress visibility

### Disk I/O

- `--remove-files` reduces disk writes significantly
- Compression happens in memory where possible
- Sequential volume processing is I/O efficient

## Error Handling

- Upload retries: 5 attempts per volume with 5s backoff
- Partial uploads: Only failed volumes need re-upload
- Volume verification: Manifest ensures all volumes present
- Timeout handling: tar process monitored, volumes processed after timeout

## Future Improvements

1. **Parallel Processing**: Upload volumes in parallel
2. **Adaptive Volume Size**: Adjust size based on available disk space
3. **Compression Level**: Adjust based on time/space tradeoffs
4. **Resume Support**: Skip already-uploaded volumes
5. **Checksum Verification**: Add SHA256 checksums to manifest

## Testing

To test the multi-volume system:

1. Verify tar supports multi-volume: `tar --help | grep 'multi-volume'`
2. Verify zstd is installed: `zstd --version`
3. Check disk space before/during archiving: `df -h`
4. Monitor temp directory: `watch -n 5 'ls -lh /work/tar-temp'`
5. Verify manifest after upload
6. Test extraction in clean environment

## Compatibility

- **Tar version**: GNU tar 1.28+ (standard on Ubuntu runners)
- **Zstd version**: 1.3.0+ (available via apt)
- **Node.js**: v20+ (for @actions/artifact v2)
- **GitHub Actions**: Works with standard ubuntu-latest runners

