# Disk Cleanup Strategy

## Overview

Building Brave/Chromium requires managing disk space carefully due to the massive source tree size (~50GB) and limited GitHub Actions runner disk space (~14GB free). We use a **two-stage cleanup strategy**:

## Two Types of Cleanup

### 1. Runner Cleanup (cleanup-disk action)

**Location**: `.github/actions/cleanup-disk/`  
**When**: Beginning of each build job (before any build steps)  
**Target**: GitHub Actions runner pre-installed tools  
**Purpose**: Free up disk space before downloading source

**What it removes**:
```
/usr/share/dotnet              # .NET SDK (~2GB)
/usr/local/lib/android         # Android SDK (~4GB)
/usr/lib/jvm                   # Java JDKs (~1GB)
/opt/ghc                       # Haskell (~1GB)
/usr/local/julia               # Julia (~500MB)
/opt/hostedtoolcache/python/*  # Old Python versions (~2GB)
/opt/hostedtoolcache/node/*    # Old Node versions (~1GB)
/opt/hostedtoolcache/go/*      # Old Go versions (~1GB)
/usr/share/swift               # Swift (~500MB)
/opt/microsoft                 # Microsoft tools
/opt/google                    # Google Chrome
/usr/lib/firefox               # Firefox
... and more
```

**Typical space freed**: ~15-20GB

**Usage in workflow**:
```yaml
- name: Setup Cleanup Disk Action
  run: npm install
  working-directory: ./.github/actions/cleanup-disk
- name: Cleanup Disk
  uses: ./.github/actions/cleanup-disk
```

### 2. Source Tree Cleanup (stage action)

**Location**: `.github/actions/stage/src/utils/disk.js`  
**When**: After `npm run init` completes (source downloaded)  
**Target**: Unnecessary platform code in Brave/Chromium source  
**Purpose**: Remove code we won't compile (iOS, Android, etc.)

**What it removes**:
```
src/ios/                       # iOS platform code (~2GB)
src/third_party/jdk/           # Java Development Kit (~500MB)
src/third_party/android_*      # Android SDKs and tools (~3GB)
... configured per platform
```

**Typical space freed**: ~5-8GB

**Configuration**:
```javascript
// In src/config/constants.js
PLATFORMS.linux = {
    cleanupDirs: [
        'ios',
        'third_party/jdk',
        'third_party/android_*'
    ]
}
```

**Usage** (automatic in stage action):
```javascript
// In src/build/linux.js
await this._cleanupAfterInit();
```

## Timeline

```
┌─────────────────────────────────────────────────────────────┐
│ Job Start                                                   │
│ Disk: ~14GB free                                            │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 1: cleanup-disk action (Runner Cleanup)               │
│ Removes: .NET, Android SDK, Java, Python, Node, etc.       │
│ Time: ~2 minutes                                            │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ After Runner Cleanup                                        │
│ Disk: ~30GB free                                            │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 2: npm run init                                        │
│ Downloads: Chromium source, dependencies                    │
│ Size: ~50GB                                                 │
│ Time: ~15 minutes                                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ After Download (tight on space!)                            │
│ Disk: ~5GB free (getting close!)                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 3: cleanupDirectories (Source Tree Cleanup)           │
│ Removes: src/ios, src/third_party/android_*, etc.          │
│ Time: ~1 minute                                             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ After Source Cleanup                                        │
│ Disk: ~12GB free (safe to build!)                          │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 4: npm run build                                       │
│ Compiles: Brave browser                                     │
│ Time: ~60-90 minutes per stage                              │
└─────────────────────────────────────────────────────────────┘
```

## Why Both Are Needed

### Without Runner Cleanup
```
Start: 14GB free
After download: -36GB (out of space!)
Build: ❌ FAILS
```

### Without Source Tree Cleanup
```
Start: 14GB free
Runner cleanup: +16GB = 30GB
After download: -20GB = 10GB
Build: ⚠️ BARELY ENOUGH (risky)
```

### With Both Cleanups
```
Start: 14GB free
Runner cleanup: +16GB = 30GB
After download: -18GB = 12GB
Source cleanup: +6GB = 18GB
Build: ✅ SAFE MARGIN
```

## Comparison Table

| Aspect | Runner Cleanup | Source Tree Cleanup |
|--------|----------------|---------------------|
| **Action** | cleanup-disk | stage (utils/disk.js) |
| **When** | Job start | After npm run init |
| **What** | Runner tools | Source code |
| **Where** | `/usr/*`, `/opt/*` | `src/*` |
| **Examples** | .NET SDK, Android SDK | iOS code, Android tools |
| **Space Freed** | 15-20GB | 5-8GB |
| **Time** | ~2 min | ~1 min |
| **Configurable** | Edit action code | Edit constants.js |

## Adding More Cleanup

### To Runner Cleanup

Edit `.github/actions/cleanup-disk/index.js`:

```javascript
const cleanupDirs = [
    // ... existing entries
    {path: '/path/to/remove', name: 'Description'},
];
```

### To Source Tree Cleanup

Edit `.github/actions/stage/src/config/constants.js`:

```javascript
PLATFORMS.linux = {
    cleanupDirs: [
        'ios',
        'third_party/jdk',
        'third_party/android_*',
        'your/new/path'  // Add here
    ]
}
```

## Monitoring Disk Usage

### During Build

Both cleanup actions show disk usage before/after:
```bash
df -h /home/runner
```

### With ncdu

The stage action includes ncdu analysis (when enabled):
```javascript
await runNcduAnalysis('disk-usage.json', '/home/runner/brave-build');
```

### In Logs

Look for these sections:
```
=== Runner Disk Space Cleanup ===
BEFORE cleanup:
  Filesystem: 75G
  Used: 61G
  Available: 14G

AFTER cleanup:
  Available: 30G

=== Cleaning up unnecessary source directories ===
Removing /home/runner/brave-build/src/ios...
Disk space after cleanup:
  Available: 18G
```

## Troubleshooting

### "No space left on device"

**Check which cleanup failed**:
1. If during `npm run init` → Runner cleanup didn't free enough
2. If during `npm run build` → Source cleanup didn't free enough

**Solutions**:
1. Add more paths to runner cleanup
2. Add more paths to source cleanup
3. Reduce volume size (more frequent checkpoints)
4. Use larger GitHub Actions runner

### Cleanup Takes Too Long

**Runner cleanup** should be ~2 minutes:
- If longer, some paths might not exist (normal)

**Source cleanup** should be ~1 minute:
- If longer, check if paths are too large

### Want to See What's Taking Space

Add ncdu analysis to workflow:
```yaml
- name: Analyze disk usage
  run: |
    sudo apt-get install -y ncdu
    ncdu -x -o disk-usage.json /home/runner
```

## Best Practices

1. **Run runner cleanup early** (first step in workflow)
2. **Run source cleanup after init** (automatic in stage action)
3. **Monitor disk usage** in logs
4. **Keep cleanup paths organized** in config
5. **Test cleanup locally** before adding to CI
6. **Document why paths are removed** in comments

## Platform-Specific Considerations

### Linux
- Can safely remove iOS, Android, macOS code
- Keep only x64 or arm64 (depending on target)

### macOS (Future)
- Can remove iOS, Android, Linux-specific code
- Need to keep macOS SDK

### Windows (Future)
- Can remove iOS, Android, Linux, macOS code
- Need to keep Windows SDK

## References

- Runner cleanup action: `.github/actions/cleanup-disk/`
- Source cleanup utility: `.github/actions/stage/src/utils/disk.js`
- Platform configs: `.github/actions/stage/src/config/constants.js`

