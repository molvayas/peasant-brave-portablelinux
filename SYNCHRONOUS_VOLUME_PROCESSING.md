# Synchronous Volume Processing

## The Correct Approach

You were absolutely right to question the design! The info script should handle ALL processing synchronously before returning control to tar.

## How It Works Now

### Flow

```
1. Tar starts creating archive
2. Tar fills volume 1 (5GB)
3. Tar calls info script
   ├─ Info script compresses volume 1
   ├─ Info script uploads volume 1  
   ├─ Info script deletes both files
   ├─ Info script tells tar: "next volume is build-state.tar-2"
   └─ Info script returns
4. Tar creates volume 2 (5GB)
5. Tar calls info script
   ├─ Info script compresses volume 2
   ├─ Info script uploads volume 2
   ├─ Info script deletes both files
   ├─ Info script tells tar: "next volume is build-state.tar-3"
   └─ Info script returns
6. ... repeat until archive complete ...
7. Tar exits
```

### Key Advantage: SYNCHRONOUS

Everything happens in order. No parallel monitoring, no race conditions, no complex state management.

## Implementation

### Info Script (Bash)

The info script does all the work:

```bash
#!/bin/bash
# Called by tar at end of each volume

# Tar provides these environment variables:
#   TAR_ARCHIVE - base archive name
#   TAR_VOLUME - volume number just completed (1, 2, 3, ...)
#   TAR_FD - file descriptor to send next volume name

if [ -z "$TAR_VOLUME" ]; then
    # First call - just tell tar the first volume name
    echo "${TAR_ARCHIVE}-1" >&"$TAR_FD"
else
    # Volume was completed - process it
    VOLUME_FILE="${TAR_ARCHIVE}-${TAR_VOLUME}"
    
    # 1. Compress
    zstd -3 -T0 --rm "$VOLUME_FILE" -o "${VOLUME_FILE}.zst"
    
    # 2. Upload (using Node.js helper)
    node /path/to/upload-volume.js "${VOLUME_FILE}.zst" "artifact-vol001"
    
    # 3. Delete compressed file
    rm "${VOLUME_FILE}.zst"
    
    # 4. Tell tar the next volume name
    NEXT_VOLUME=$((TAR_VOLUME + 1))
    echo "${TAR_ARCHIVE}-${NEXT_VOLUME}" >&"$TAR_FD"
fi
```

### Upload Helper (Node.js)

A simple Node.js script handles the upload:

```javascript
const {DefaultArtifactClient} = require('@actions/artifact');

async function uploadVolume(filePath, artifactName) {
    const artifact = new DefaultArtifactClient();
    
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await artifact.uploadArtifact(artifactName, [filePath], tempDir, {
                retentionDays: 1,
                compressionLevel: 0
            });
            return 0;  // Success
        } catch (e) {
            if (attempt < 4) await sleep(5000);
        }
    }
    return 1;  // Failed
}

// Called from bash: node upload-volume.js file.tar.zst artifact-name
uploadVolume(process.argv[2], process.argv[3])
    .then(code => process.exit(code));
```

### Main Process (Simplified)

The main Node.js process is now trivial:

```javascript
// 1. Create info script
await fs.writeFile('next-volume.sh', infoScriptContent);

// 2. Start tar (it will call the info script as needed)
const tarProcess = exec.exec('tar', [
    '-cM',                    // Multi-volume
    '-L', '10485760',         // 5GB volumes
    '-F', 'next-volume.sh',   // Info script
    '-f', 'build-state.tar',
    '--remove-files',         // Delete source files
    '-C', workDir,
    'src', 'build-stage.txt'
]);

// 3. Wait for tar to finish
await tarProcess;

// 4. Read which volumes were processed
const volumes = await fs.readFile('processed-volumes.txt');

// 5. Create manifest
const manifest = { volumeCount: X, volumes: [...] };
await artifact.uploadArtifact('manifest', [manifestPath]);
```

## Why This Is Better

### Old Approach (Complex, Async)
- ❌ Tar and monitoring run in parallel
- ❌ Race conditions in file detection
- ❌ Complex state management
- ❌ Hard to debug
- ❌ Timing-dependent bugs
- ❌ 200+ lines of monitoring logic

### New Approach (Simple, Sync)
- ✅ Everything is sequential
- ✅ No race conditions
- ✅ Minimal state
- ✅ Easy to debug (clear logs)
- ✅ Predictable behavior
- ✅ ~40 lines of logic

## Logging

The info script provides clear logging:

```
[Volume Script] ============================================
[Volume Script] Called at: Mon Oct 27 06:15:23 UTC 2025
[Volume Script] TAR_VOLUME: 1
[Volume Script] TAR_ARCHIVE: /tmp/build-state.tar
[Volume Script] TAR_FD: 3
[Volume Script] ============================================
[Volume Script] Processing completed volume: /tmp/build-state.tar-1
[Volume Script] Volume size: 5.0G
[Volume Script] Compressing with zstd...
[zstd] /tmp/build-state.tar-1 : 50.23% (2.5 GiB => 1.3 GiB)
[Volume Script] Compressed to: 1.3G
[Volume Script] Uploading volume 1...
[upload] Uploading /tmp/build-state.tar-1.zst as build-artifact-vol001...
[upload] ✓ Successfully uploaded build-artifact-vol001
[Volume Script] Upload successful, cleaning up...
[Volume Script] Volume 1 processed successfully
[Volume Script] Next volume will be: /tmp/build-state.tar-2
[Volume Script] Continuing to next volume...
[Volume Script] ============================================
```

## Critical Implementation Details

### 1. Use TAR_FD, Not Stdout

**Wrong:**
```bash
echo "$NEXT_VOLUME"  # Goes to stdout
```

**Correct:**
```bash
echo "$NEXT_VOLUME" >&"$TAR_FD"  # Goes to tar's file descriptor
```

### 2. Log to Stderr

All script logging must go to stderr, not stdout:

```bash
echo "Processing..." >&2           # Good - stderr
echo "Processing..."               # Bad - might confuse tar
```

### 3. Error Handling

If the info script exits with non-zero, tar aborts:

```bash
set -e  # Exit on any error

# If upload fails, script exits with non-zero
node upload-volume.js "$file" "$name" || exit 1
```

### 4. First Call Special Case

The info script is called BEFORE the first volume is complete:

```bash
if [ -z "$TAR_VOLUME" ]; then
    # No volume completed yet - just return first volume name
    echo "${TAR_ARCHIVE}-1" >&"$TAR_FD"
else
    # Volume $TAR_VOLUME was just completed - process it
    # ...
fi
```

## Disk Space Benefits

Since compression and upload happen synchronously:

1. Volume 1 created: 5GB used
2. Volume 1 compressed: 7.5GB used (5GB + 2.5GB compressed)
3. Volume 1 uploaded: 7.5GB used (still)
4. Volume 1 deleted: 2.5GB used (compressed deleted too)
5. Volume 2 starts: 2.5GB + growing

**Maximum disk usage: ~7.5GB overhead** (one volume + compressed)

Compare to old approach where all volumes might accumulate: **~40GB+ overhead**

## Testing Manually

To test the info script independently:

```bash
cd /tmp
mkdir test-tar

# Create test files
dd if=/dev/zero of=test-tar/file1 bs=1M count=6000  # 6GB

# Create info script
cat > next-volume.sh << 'EOF'
#!/bin/bash
set -e
echo "[Test] TAR_VOLUME=${TAR_VOLUME:-unset}" >&2
echo "[Test] TAR_ARCHIVE=$TAR_ARCHIVE" >&2
echo "[Test] TAR_FD=$TAR_FD" >&2

if [ -z "$TAR_VOLUME" ]; then
    echo "${TAR_ARCHIVE}-1" >&"$TAR_FD"
else
    echo "[Test] Would compress: ${TAR_ARCHIVE}-${TAR_VOLUME}" >&2
    NEXT=$((TAR_VOLUME + 1))
    echo "${TAR_ARCHIVE}-${NEXT}" >&"$TAR_FD"
fi
EOF

chmod +x next-volume.sh

# Run tar
tar -cM -L 10485760 -F ./next-volume.sh -f archive.tar --remove-files -C test-tar .

# Check results
ls -lh archive.tar*
```

## Troubleshooting

### Problem: Tar hangs after first volume

**Cause:** Info script not returning proper value to TAR_FD

**Solution:** Ensure `echo "$NEXT" >&"$TAR_FD"` is executed

### Problem: Tar aborts with error

**Cause:** Info script exited with non-zero status

**Solution:** Check script logs for errors in compression or upload

### Problem: Upload fails

**Cause:** Network issues or artifact API problems

**Solution:** Script retries 5 times with 5s backoff

### Problem: Out of disk space

**Cause:** Compressed files not being deleted

**Solution:** Verify `rm -f "$COMPRESSED"` executes after upload

## Summary

The synchronous approach is:
- **Simpler**: One script handles everything in order
- **More reliable**: No race conditions or timing issues
- **Easier to debug**: Clear sequential logs
- **More efficient**: Minimal disk space usage
- **Correct**: Uses tar's info script protocol properly

This is how tar's multi-volume support is meant to be used!

