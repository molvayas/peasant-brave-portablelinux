# Volume Monitoring Fix

## Issue Identified

The multi-volume tar archiving process was hanging after the first volume completed. The first volume would compress and upload successfully, but subsequent volumes were not being detected or processed.

## Root Causes

### 1. **Async Overlap in setInterval**
The original code used `setInterval` with an `async` callback, but JavaScript's `setInterval` doesn't wait for async operations to complete before scheduling the next iteration. This could cause:
- Multiple monitoring iterations running simultaneously
- Race conditions in volume processing
- Errors being swallowed or delayed

### 2. **Insufficient Logging**
The original monitoring logic had minimal logging, making it impossible to debug why volumes weren't being detected:
- No visibility into what files existed in the temp directory
- No indication of whether the monitoring loop was even running
- No way to tell if volumes were being created but not detected

### 3. **Volume Detection Issues**
The volume completion detection logic had potential issues:
- Relied on `.complete` marker files that might not be created reliably
- The 10-second "not modified" timeout was too short for large volumes
- No clear indication of why a volume was skipped

## Fixes Applied

### 1. **Prevent Async Overlap**
```javascript
let isMonitoring = false;  // Prevent overlapping monitor runs

const monitorAndProcessVolumes = async () => {
    if (isMonitoring) {
        console.log('[Monitor] Already running, skipping this iteration');
        return;
    }
    
    isMonitoring = true;
    try {
        // ... monitoring logic ...
    } finally {
        isMonitoring = false;
    }
};

const monitorInterval = setInterval(() => {
    monitorAndProcessVolumes().catch(e => {
        console.error(`[Monitor] Unhandled error: ${e.message}`);
    });
}, 10000);  // Check every 10 seconds
```

**Benefits:**
- Only one monitoring iteration runs at a time
- Errors are properly caught and logged
- Increased interval from 5s to 10s to prevent excessive checking

### 2. **Comprehensive Logging**
Added `[Monitor]` and `[Main]` prefixes to all log messages to track execution flow:

```javascript
console.log(`[Monitor] Found ${files.length} files in temp dir`);
console.log(`[Monitor] Found ${volumeFiles.length} unprocessed volume(s): ${volumeFiles.join(', ')}`);
console.log(`[Monitor] Checking ${volumeFile}: marker=${hasMarker}, tarEnded=${tarEnded}`);
console.log(`[Monitor] ${volumeFile} last modified ${age.toFixed(1)}s ago`);
```

**Benefits:**
- Clear visibility into what's happening at each step
- Easy to identify which component is producing which log
- Timestamps help identify timing issues

### 3. **Improved Volume Detection**

#### Extended Timeout
Changed from 10 seconds to 15 seconds for "not modified" detection:
```javascript
if (age < 15) {
    console.log(`[Monitor] ${volumeFile} still being written, skipping`);
    continue;
}
```

#### Better File Filtering
Added exclusions for `.zst` files to avoid detecting compressed files:
```javascript
const volumeFiles = files.filter(f => 
    f.startsWith(`${archiveBaseName}.tar`) && 
    f.match(/\.tar(-\d+)?$/) &&
    !f.endsWith('.complete') &&
    !f.endsWith('.zst') &&  // Don't detect compressed files
    !processedVolumes.has(f)
);
```

#### Multiple Final Passes
After tar completes, run the monitor function multiple times to catch any stragglers:
```javascript
clearInterval(monitorInterval);
console.log('[Main] Stopped monitoring interval');

console.log('[Main] Running final monitoring pass...');
await new Promise(r => setTimeout(r, 5000));
await monitorAndProcessVolumes();

console.log('[Main] Waiting 10 more seconds and running one more final pass...');
await new Promise(r => setTimeout(r, 10000));
await monitorAndProcessVolumes();
```

### 4. **zstd Installation**
Re-added `zstd` to the package installation (user had removed it):
```javascript
await exec.exec('sudo', ['apt-get', 'install', '-y', 
    'build-essential', 'git', 'python3', 'python3-pip', 
    'python-setuptools', 'python3-distutils', 'python-is-python3',
    'curl', 'lsb-release', 'sudo', 'tzdata', 'wget', 'ncdu', 'zstd'], {ignoreReturnCode: true});
```

Added verification before starting:
```javascript
console.log('Verifying zstd is installed...');
try {
    await exec.exec('zstd', ['--version']);
    console.log('✓ zstd is available');
} catch (e) {
    throw new Error('zstd is not installed!');
}
```

### 5. **Enhanced Tar Logging**
Added logging for the tar command and its exit:
```javascript
console.log('[Tar] Starting tar command with args:', [...].join(' '));

const tarProcess = exec.exec('tar', [...]).then(code => {
    console.log(`[Tar] Process exited with code: ${code}`);
    tarExitCode = code;
});
```

## Expected Behavior Now

With these fixes, you should see output like this:

```
[Tar] Starting tar command with args: -cM -L 10485760 -F /path/to/next-volume.sh ...
[Monitor] Found 3 files in temp dir
[Monitor] Found 0 unprocessed volume(s): 

(... tar creates first volume ...)

[Monitor] Found 4 files in temp dir
[Monitor] Found 1 unprocessed volume(s): build-state.tar
[Monitor] Checking build-state.tar: marker=false, tarEnded=false
[Monitor] build-state.tar last modified 2.3s ago
[Monitor] build-state.tar still being written, skipping

(... 10 seconds later ...)

[Monitor] Found 4 files in temp dir
[Monitor] Found 1 unprocessed volume(s): build-state.tar
[Monitor] Checking build-state.tar: marker=false, tarEnded=false
[Monitor] build-state.tar last modified 16.7s ago
[Monitor] build-state.tar appears complete (not modified for 16.7s)

=== Processing Volume 1: build-state.tar ===
Compressing with zstd...
✓ Compressed
Uploading as build-artifact-vol001...
✓ Uploaded build-artifact-vol001
✓ Cleaned up

(... tar creates second volume ...)

[Monitor] Found 4 files in temp dir
[Monitor] Found 1 unprocessed volume(s): build-state.tar-1
[Monitor] Checking build-state.tar-1: marker=false, tarEnded=false
...
```

## Debugging Tips

If volumes still aren't being processed:

### 1. Check if volumes are being created
Look for log lines like:
```
[Monitor] Found X files in temp dir
[Monitor] Found Y unprocessed volume(s): file1, file2, ...
```

If Y is always 0, tar might not be creating volumes.

### 2. Check modification times
Look for:
```
[Monitor] build-state.tar last modified X.Xs ago
```

If X is always small (<15s), tar might still be writing to the file.

### 3. Check if monitoring is running
You should see `[Monitor]` logs every 10 seconds. If they stop, the monitoring loop crashed.

### 4. Check for tar errors
Look for:
```
[Tar] Process exited with code: X
```

Non-zero exit codes indicate tar failed.

### 5. Verify zstd is working
You should see:
```
✓ zstd is available
```

If not, zstd isn't installed properly.

## Alternative: Manual Testing

To test the volume creation manually:

```bash
cd /home/runner/brave-build
mkdir -p tar-temp

# Create a simple volume script
cat > tar-temp/next-volume.sh << 'EOF'
#!/bin/bash
read ARCHIVE
if [[ "$ARCHIVE" =~ -([0-9]+)$ ]]; then
    CURRENT_NUM="${BASH_REMATCH[1]}"
    NEXT_NUM=$((CURRENT_NUM + 1))
    NEXT_ARCHIVE="${ARCHIVE%-*}-${NEXT_NUM}"
else
    NEXT_ARCHIVE="${ARCHIVE}-1"
fi
echo "$NEXT_ARCHIVE"
EOF

chmod +x tar-temp/next-volume.sh

# Test tar multi-volume
tar -cM -L 10485760 -F tar-temp/next-volume.sh \
    -f tar-temp/test.tar \
    -C /home/runner/brave-build \
    src/some-file

# Check what was created
ls -lh tar-temp/
```

## Performance Notes

- **Compression**: Changed from `-19` (max) to `-3` (fast) for faster processing
- **Monitoring interval**: Changed from 5s to 10s to reduce overhead
- **Volume timeout**: Changed from 10s to 15s for more reliability
- **Multiple final passes**: Ensures no volumes are missed at the end

## Future Improvements

1. **Better volume script**: Use more robust markers for volume completion
2. **Parallel compression**: Compress and upload in parallel if disk space allows
3. **Progress reporting**: Show percentage complete based on volume count
4. **Checksum verification**: Verify each volume after upload
5. **Resume support**: Skip volumes that are already uploaded

