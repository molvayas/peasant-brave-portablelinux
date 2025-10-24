# Workflow Design Documentation (Linux)

## Architecture Overview

This document explains the design decisions and architecture of the multi-stage Brave Browser build workflow for Linux.

## Problem Statement

Building Brave Browser on GitHub Actions (Linux) presents several challenges:

1. **Time limit**: GitHub Actions has a 6-hour timeout per job
2. **Resource constraints**: Limited CPU (2-4 cores), RAM (7GB), and disk (14GB initially)
3. **Build duration**: Brave builds take 6-15 hours on constrained hardware
4. **Network requirements**: Initial download is ~60GB
5. **State persistence**: Need to resume after timeouts
6. **System dependencies**: Chromium requires many system packages

## Solution: Multi-Stage Build Pipeline

### Core Concepts

#### 1. Sequential Stages

The build is divided into 6 sequential stages (fewer than Windows due to faster Linux builds):

```
build-1 → build-2 → build-3 → build-4 → build-5 → build-6 → publish-release
```

Each stage:
- Runs for up to 6 hours (GitHub enforces this)
- Saves progress before timeout
- Next stage resumes from saved state

#### 2. Artifact Checkpointing

**Intermediate artifacts** (`build-artifact`):
- Created when stage doesn't complete build
- Contains compressed `src/` directory with all build state
- Uses tar + zstd compression (native Linux, faster than 7zip)
- Uploaded to GitHub Actions artifacts storage
- Next stage downloads and extracts

**Final artifacts** (`brave-browser-linux`):
- Created when build completes successfully
- Contains packaged browser tarball (tar.xz)
- Published to GitHub Releases

#### 3. Build State Machine

The stage action uses a state machine:

```
init → build → package → done
 ↓       ↓        ↓
checkpoint each step
```

States stored in `build-stage.txt`:
- **init**: Running `npm run init` + `install-build-deps.sh`
- **build**: Running `npm run build`
- **package**: Creating distribution packages
- **done**: Build complete

### Workflow Structure

#### main.yml

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
```

**Job dependencies**:
```
build-1 (no deps)
  ↓
build-2 (needs: build-1)
  ↓
build-3 (needs: build-2)
  ↓
...
  ↓
build-6 (needs: build-5)
  ↓
publish-release (needs: build-6)
```

**Output propagation**:
- Each stage outputs `finished: true/false`
- Next stage checks `needs.*.outputs.finished`
- If `finished: true`, stage exits immediately

#### action.yml

Defines the custom stage action:

```yaml
inputs:
  finished: bool        # Previous stage completion status
  from_artifact: bool   # Whether to download checkpoint
outputs:
  finished: bool        # This stage completion status
runs:
  using: node20
  main: index.js
```

#### index.js

Main action logic:

```javascript
if (finished) {
    // Previous stage completed, pass through
    return;
}

if (from_artifact) {
    // Download and extract previous checkpoint
    downloadArtifact();
    extract();  // tar + zstd
}

// Continue build from current state
switch (currentState) {
    case 'init':
        runNpmInit();
        runInstallBuildDeps();  // Linux-specific!
        if (success) state = 'build';
        break;
    case 'build':
        runNpmBuild();
        if (success) state = 'package';
        break;
    case 'package':
        createTarball();
        uploadFinalArtifact();
        return finished = true;
}

// Save checkpoint
compressState();  // tar + zstd
uploadCheckpoint();
return finished = false;
```

## Design Decisions

### 1. Why 6 Stages?

**Analysis**:
- Stage 1: Init downloads + install-build-deps (~2-3 hours)
- Stages 2-4: Compilation (~6-10 hours on 2-4 cores)
- Stages 5-6: Linking and packaging (~2-3 hours)

**Rationale**:
- Provides 6 hours per stage
- Covers typical build time (~12-18 hours)
- Fewer stages than Windows (8) due to faster Linux builds
- Balances checkpoint overhead vs. progress

**Alternative considered**: 10 stages
- **Rejected**: Overkill for Linux, adds unnecessary overhead

### 2. Why tar + zstd Instead of 7zip?

**Comparison**:

| Tool | Compression | Speed | Native | Multi-threaded |
|------|-------------|-------|--------|----------------|
| 7zip | Better | Slower | No (needs install) | Limited |
| tar+zstd | Good | Faster | Yes (Ubuntu) | Yes (-T0) |
| tar+gzip | Worse | Moderate | Yes | No |
| tar+xz | Best | Slowest | Yes | Yes |

**Selected**: tar + zstd level 3
- Native on Ubuntu 22.04+
- Multi-threaded compression
- Good balance of speed and size
- Consistent with ungoogled-chromium-portablelinux approach

### 3. Why Native Build Instead of Docker?

**Comparison with ungoogled-chromium-portablelinux**:

| Aspect | Native (this) | Docker |
|--------|---------------|--------|
| Setup time | Faster | Slower (image build) |
| Build speed | Faster | Slightly slower |
| Isolation | Process | Container |
| Complexity | Medium | High |
| Debugging | Easier | Harder |
| Reproducibility | Good | Excellent |

**Selected**: Native build
- Simpler implementation (consistent with Windows version)
- Faster execution (no container overhead)
- Easier to debug
- Good enough reproducibility for CI

### 4. Why install-build-deps.sh Is Critical

This script (from Chromium):
- Installs 100+ system packages
- Sets up GTK, X11, ALSA, PulseAudio libraries
- Configures fonts and locale
- Installs debugging tools
- **Without it, build will fail with missing library errors**

**Flags used**:
- `--no-prompt`: Non-interactive mode for CI
- `--no-chromeos-fonts`: Skip ChromeOS fonts (not needed)
- `--unsupported`: Fallback for non-Ubuntu distributions

### 5. Why Component Build by Default?

**Build types**:

| Type | Speed | Size | Use Case |
|------|-------|------|----------|
| Component | Fastest | Largest | Development, CI |
| Static | Slow | Medium | Testing |
| Release | Slowest | Smallest | Production |

**Selected**: Component build (default)
- Fastest incremental builds
- Acceptable for CI testing
- Can be changed to Release in workflow

### 6. Artifact Retention

**Intermediate artifacts**: 1 day
- Only needed between stages
- Automatically deleted after workflow completes
- Reduces storage costs

**Final artifacts**: 7 days
- Published to GitHub Releases (permanent)
- Artifacts serve as temporary backup
- Auto-cleanup after successful release

## Linux-Specific Optimizations

### 1. Compression Strategy

```bash
# Compress
tar -cf build-state.tar.zst \
    --use-compress-program='zstd -3 -T0' \
    --exclude=src/.git \
    --exclude='*.o' \
    --exclude='*.a' \
    src build-stage.txt

# Extract
tar -xf build-state.tar.zst \
    --use-compress-program=unzstd \
    -C /home/runner/brave-build
```

**Benefits**:
- `-T0`: Use all CPU cores for compression
- Level 3: Good balance (faster than level 5-9)
- Native tool: No installation needed
- Consistent with Linux ecosystem

### 2. Disk Space Management

Ubuntu runners start with ~14GB free, but Brave needs ~100GB.

**Solution**:
```javascript
// In import-cache.sh (ungoogled-chromium approach)
sudo rm -rf /usr/local/lib/android \
            /usr/local/.ghcup \
            /usr/lib/jvm \
            /usr/lib/google-cloud-sdk \
            /usr/lib/dotnet \
            /usr/share/swift
```

**Result**: Frees ~25GB of space

**Applied automatically** during artifact extraction in our workflow.

### 3. Dependency Installation

**Two-phase approach**:

Phase 1: Base packages (before clone)
```bash
apt-get install build-essential git python3 \
    python-setuptools python3-distutils python-is-python3
```

Phase 2: Chromium packages (after npm init)
```bash
./src/build/install-build-deps.sh --no-prompt --no-chromeos-fonts
```

**Why split**:
- Base packages needed to clone and init
- Chromium packages need source tree to exist
- install-build-deps.sh is comprehensive (100+ packages)

## Monitoring and Debugging

### Logging Strategy

**Console output**:
```javascript
console.log(`finished: ${finished}, from_artifact: ${from_artifact}`);
console.log(`Resuming from stage: ${currentStage}`);
console.log(`Building Brave version: ${brave_version}`);
```

**Actions integration**:
```javascript
core.setOutput('finished', true);
core.exportVariable('PYTHONUNBUFFERED', '1');
```

### Debugging Failed Builds

**Check**:
1. Download artifact from failed stage
2. Extract `build-stage.txt` to see last completed phase
3. Review action logs for error messages
4. Check disk space usage (should have 60GB+ free)
5. Verify install-build-deps.sh ran successfully

**Common issues**:
- Missing dependencies → check install-build-deps.sh output
- Out of disk space → increase stages or clean more aggressively
- Compilation errors → version mismatch or patch failures

### Performance Metrics

**Typical stage durations**:
```
Stage 1: 2-3h (npm run init + install-build-deps.sh)
Stage 2: 5-6h (early compilation, may timeout)
Stage 3: 5-6h (mid compilation, may timeout)
Stage 4: 4-5h (late compilation)
Stage 5: 2-3h (linking)
Stage 6: Skip (finished=true)

Total: ~12-20 hours
```

**Faster than Windows** because:
- Clang is faster than MSVC
- No path length limitations
- Better filesystem performance
- Native tar/zstd compression

## Scalability Considerations

### Horizontal Scaling

**Possible approach**: Parallel builds per architecture
```yaml
strategy:
  matrix:
    arch: [x86_64, arm64]
```

**Considerations**:
- arm64 needs cross-compilation or native runner
- Both architectures build independently
- Final stage combines artifacts

**Status**: Not implemented (x64 only currently)

### Vertical Scaling

**Current**: 2-4 core, 7GB RAM
**If GitHub offered larger runners**:
- 8-core: ~8 hour build (2-3 stages needed)
- 16-core: ~4 hour build (1 stage might suffice)

### Caching Strategies

**Potential improvements**:

1. **Actions cache**: Store depot_tools, download_cache
   - Benefit: Faster init
   - Issue: 10GB cache limit, Chromium is larger
   
2. **Docker layer cache**: Pre-built base image
   - Benefit: Skip install-build-deps.sh
   - Issue: Large image, maintenance overhead

3. **ccache/sccache**: Compilation cache
   - Benefit: Faster rebuilds
   - Issue: Requires persistent storage

## Comparison with Related Projects

### vs. peasant-brave-windows

| Aspect | Windows | Linux (this) |
|--------|---------|--------------|
| Stages | 8 | 6 |
| Compression | 7zip | tar+zstd |
| Build speed | Slower | Faster |
| Complexity | Higher | Medium |
| Timeout handling | Manual (execWithTimeout) | GitHub-enforced |

### vs. ungoogled-chromium-portablelinux

| Aspect | ungoogled-chromium | Brave (this) |
|--------|-------------------|--------------|
| Build tool | Python script | npm scripts |
| Container | Docker | Native |
| Stages | 10 (prep + 9 builds) | 6 |
| Output | AppImage + tar.xz | tar.xz |
| Matrix build | Yes (arm64, x86_64) | No (x86_64 only) |

### vs. Manual Build

| Aspect | Manual | Automated |
|--------|--------|-----------|
| Setup time | 1-2 hours | Automatic |
| Build time | 2-4 hours | 12-20 hours |
| Reproducibility | Variable | High |
| Cost | Hardware | $0 (GitHub free tier) |

## Security Considerations

### 1. Source Verification

- Tags fetched from official brave-core repository
- GitHub Actions OIDC token for authentication
- No arbitrary code execution from external sources

### 2. Artifact Integrity

- Artifacts stored in GitHub-managed storage
- Short retention periods (1-7 days)
- No external distribution of intermediates

### 3. Sudo Usage

- Only used for install-build-deps.sh
- Script from official Chromium repository
- No user input, flags prevent interactive prompts

## Future Enhancements

### Short Term

1. **ARM64 support**: Add arm64 builds alongside x64
2. **AppImage packaging**: Create AppImage in addition to tarball
3. **Debian package**: Build .deb for easier installation

### Medium Term

1. **Matrix builds**: Parallel x64 and arm64
2. **Release builds**: Option to build optimized Release instead of Component
3. **Symbols packaging**: Optional debug symbols tarball

### Long Term

1. **Docker option**: Alternative Docker-based build path
2. **Distributed builds**: Use remote execution (Bazel/Goma)
3. **Build cache**: Persistent ccache/sccache across runs

## Conclusion

This multi-stage workflow successfully addresses the constraints of GitHub Actions while building Brave Browser on Linux. The design balances:

- **Reliability**: Checkpointing and retry logic
- **Efficiency**: Native tools (tar/zstd), fewer stages than Windows
- **Maintainability**: Consistent with peasant-brave-windows approach
- **Extensibility**: Easy to add more stages or architectures

The approach leverages Linux advantages (faster builds, native tools, no path limits) while maintaining consistency with the Windows workflow structure.

