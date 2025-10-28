# macOS Support

## Overview

The refactored action now includes full macOS support with all platform-specific requirements properly integrated.

## Key Differences from Linux

### 1. Disk Cleanup
**Linux**: Removes .NET SDK, Android SDK, old Python/Node versions
**macOS**: Removes iOS/watchOS/tvOS/xrOS simulator runtimes (~95GB!)

See: `.github/actions/cleanup-disk-macos/`

### 2. Build Tools
**Linux**: Uses native `tar` and `timeout` commands
**macOS**: Uses `gtar` (GNU tar) and `gtimeout` from Homebrew coreutils

### 3. Build Dependencies
**Linux**: Runs `install-build-deps.sh` to install Chromium deps
**macOS**: No install-build-deps.sh - deps already on runner, just needs Xcode setup

### 4. Xcode Setup (macOS Only)
- Selects preferred Xcode version (26.0, 16.3, 16.2, or 16.1)
- Installs Metal toolchain for graphics compilation
- Verifies Metal compiler is available

### 5. Packaging
**Linux**: Packages specific files (brave, libs, locales, etc.)
**macOS**: Packages entire `out/` directory (contains .app bundle)

## Implementation Details

### MacOSBuilder (src/build/macos.js)

Implements the full macOS build logic:

```javascript
class MacOSBuilder {
    async initialize() {
        // Install Homebrew deps (coreutils, ncdu)
        // Setup Xcode and Metal toolchain
        // Clone brave-core
        // Install npm deps
    }
    
    async runInit() {
        // Run npm run init --no-history
        // Skip install-build-deps.sh (macOS doesn't use it)
        // Cleanup iOS, Android source code
    }
    
    async runBuild() {
        // Calculate timeout (same as Linux)
        // Use gtimeout instead of timeout
        // Run npm run build with timeout
    }
    
    async package() {
        // Archive entire out/ directory with gtar
        // Creates tar.xz package
    }
}
```

### Xcode Setup Process

```javascript
// Tries Xcode versions in order of preference:
const xcodeVersions = [
    '/Applications/Xcode_26.0.app',   // Preferred (has Metal toolchain)
    '/Applications/Xcode_16.3.app',
    '/Applications/Xcode_16.2.app',
    '/Applications/Xcode_16.1.app'
];

// Selects first available
// Downloads Metal toolchain component
// Verifies metal compiler is available
```

### Timeout Command

```javascript
// Linux:
execWithTimeout('npm', ['run', 'build'], {
    cwd: braveDir,
    timeoutSeconds: 16800
});
// Uses: timeout -k 5m -s INT 16800s npm run build

// macOS:
execWithTimeout('npm', ['run', 'build'], {
    cwd: braveDir,
    timeoutSeconds: 16800,
    useGTimeout: true
});
// Uses: gtimeout -k 5m -s INT 16800s npm run build
```

### Archive Operations

Both platforms now use the same multi-volume archive system, but:

**Linux**: Uses `tar`
```bash
tar -cM -L 5G -F script.sh -f archive.tar ...
```

**macOS**: Uses `gtar` (GNU tar from Homebrew)
```bash
gtar -cM -L 5G -F script.sh -f archive.tar ...
```

The `tarCommand` is configured in `constants.js` and passed through the orchestrator.

## Platform Configuration

```javascript
// In src/config/constants.js
PLATFORMS.macos = {
    runner: 'macos-latest',
    workDir: '/Users/runner/brave-build',
    nodeModulesCache: '/Users/runner/.npm',
    outputDirName: 'Component',
    executable: 'Brave Browser.app',
    packageFormat: 'tar.xz',
    tarCommand: 'gtar',  // ← Use GNU tar
    dependencies: [],    // Installed via Homebrew
    cleanupDirs: [
        'ios',
        'third_party/jdk',
        'third_party/android_*'
    ]
}
```

## Cleanup Strategy

### Runner Cleanup (macOS-specific)
Located in: `.github/actions/cleanup-disk-macos/`

Removes:
- iOS Simulator Runtime (~32GB)
- xrOS Simulator Runtime (~30GB)
- watchOS Simulator Runtime (~17GB)
- tvOS Simulator Runtime (~16GB)
- Android SDKs
- Disables Spotlight indexing

**Total space freed**: ~95GB!

### Source Tree Cleanup (Same as Linux)
Uses: `src/utils/disk.js` cleanupDirectories()

Removes:
- `src/ios/`
- `src/third_party/jdk/`
- `src/third_party/android_*`

## Usage in Workflow

### Basic macOS Build

```yaml
jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      
      - name: Setup Cleanup Disk Action
        run: npm install
        working-directory: ./.github/actions/cleanup-disk-macos
      
      - name: Cleanup Disk
        uses: ./.github/actions/cleanup-disk-macos
      
      - name: Setup Stage
        run: npm install
        working-directory: ./.github/actions/stage
      
      - name: Run Stage
        id: stage
        uses: ./.github/actions/stage
        with:
          finished: false
          from_artifact: false
          platform: macos  # ← Specify macOS
          arch: x64
    
    outputs:
      finished: ${{ steps.stage.outputs.finished }}
```

### Multi-Platform Matrix

```yaml
strategy:
  matrix:
    include:
      - platform: linux
        os: ubuntu-latest
        cleanup-action: cleanup-disk
      - platform: macos
        os: macos-latest
        cleanup-action: cleanup-disk-macos

jobs:
  build:
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      
      # ... setup steps ...
      
      - name: Cleanup Disk
        uses: ./.github/actions/${{ matrix.cleanup-action }}
      
      - name: Run Stage
        uses: ./.github/actions/stage
        with:
          platform: ${{ matrix.platform }}
          finished: false
          from_artifact: false
```

## What's Shared vs Platform-Specific

### Shared (Same Code)
✅ Multi-volume archiving system
✅ Checkpoint/resume logic
✅ Timeout calculation
✅ Artifact management
✅ Build stage progression
✅ Error handling
✅ Orchestration

### Platform-Specific
🔧 **Linux**:
- Runner cleanup (cleanup-disk)
- Uses `tar` and `timeout`
- Runs `install-build-deps.sh`
- Packages specific files

🍎 **macOS**:
- Runner cleanup (cleanup-disk-macos)
- Uses `gtar` and `gtimeout`
- Skips `install-build-deps.sh`
- Xcode and Metal toolchain setup
- Packages entire `out/` directory

## Testing macOS Build

1. **Create test workflow** for macOS:
   ```yaml
   # .github/workflows/test-macos.yml
   name: Test Brave Build (macOS)
   on: workflow_dispatch
   
   jobs:
     build-1:
       runs-on: macos-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: '20'
         - run: npm install
           working-directory: ./.github/actions/cleanup-disk-macos
         - uses: ./.github/actions/cleanup-disk-macos
         - run: npm install
           working-directory: ./.github/actions/stage
         - id: stage
           uses: ./.github/actions/stage
           with:
             platform: macos
             finished: false
             from_artifact: false
   ```

2. **Monitor logs** for:
   - Homebrew installations
   - Xcode selection
   - Metal toolchain installation
   - gtar/gtimeout usage
   - Checkpoint creation

3. **Verify**:
   - Simulator runtimes removed (~95GB freed)
   - Xcode 26.0 or 16.x selected
   - Metal toolchain installed
   - Build uses gtimeout
   - Archive uses gtar

## Troubleshooting

### Issue: gtimeout not found
**Solution**: Ensure coreutils is installed in builder initialization
```javascript
await exec.exec('brew', ['install', 'coreutils']);
```

### Issue: Metal toolchain download fails
**Solution**: This is expected on older Xcode versions - build will continue anyway

### Issue: Xcode not found
**Solution**: Runner should have Xcode pre-installed, check runner image

### Issue: gtar not found  
**Solution**: GNU tar should be pre-installed on GitHub Actions macOS runners

## Benefits of Shared Architecture

The macOS builder shares all the sophisticated features developed for Linux:

✅ **Multi-volume archiving** - Handles large macOS builds (out/ can be huge)
✅ **Checkpoint/resume** - Resumes from exactly where it timed out
✅ **Streaming operations** - Minimizes disk usage
✅ **Smart timeout** - Accounts for time already spent
✅ **Retry logic** - Handles transient upload failures
✅ **Comprehensive logging** - Same log structure and debugging

## Comparison with Original macOS Implementation

| Feature | Original | Refactored |
|---------|----------|------------|
| **Multi-volume** | ❌ Single archive | ✅ 5GB volumes |
| **Disk optimization** | Basic | Advanced (streaming) |
| **Timeout** | Basic | Smart (accounts for elapsed) |
| **Modularity** | Monolithic | Clean builder class |
| **Shared code** | Duplicated | Shared utilities |
| **Documentation** | Minimal | Comprehensive |

## Files

### macOS-Specific
- `.github/actions/cleanup-disk-macos/` - Runner cleanup
- `src/build/macos.js` - macOS builder (241 lines)

### Platform-Agnostic (Works for Both)
- `src/archive/multi-volume.js` - Archive operations
- `src/orchestrator.js` - Build orchestration
- `src/utils/*` - All utilities
- `src/config/constants.js` - Configuration

## Next Steps

1. ✅ macOS builder implemented
2. ✅ macOS cleanup-disk action added
3. ✅ Platform-specific logic integrated
4. ✅ gtar/gtimeout support added
5. ✅ Xcode setup implemented
6. ⚠️ Needs testing on actual macOS runner

## Status

**macOS Support**: ✅ **Complete**

The action now supports both Linux and macOS with proper platform-specific handling while sharing all the advanced features (multi-volume archiving, smart timeouts, checkpoint/resume, etc.).

Ready for testing on macOS runners!

