# Brave Build Process Notes (Linux)

## Understanding Brave's Build System on Linux

Brave Browser is built on top of Chromium with custom patches and features. The Linux build process is similar to Windows but with some platform-specific differences.

### 1. Repository Structure

```
/home/runner/brave-build/
└── src/
    ├── brave/          # brave-core repository
    ├── chrome/         # Chromium browser
    ├── chromium/       # Chromium base
    ├── build/          # Build scripts (including install-build-deps.sh)
    └── out/
        └── Component/  # Build output (Component build by default)
```

### 2. Build Phases

#### Phase 1: Initialization (`npm run init`)

This downloads ~60GB of dependencies:
- Chromium source code (via depot_tools/gclient)
- ~240 dependent repositories
- Build tools and SDKs
- Platform-specific dependencies

**Time estimate**: 1-3 hours depending on network speed

**Environment setup**:
- Creates `.gclient` configuration file
- Sets up depot_tools
- Configures gclient for Linux platform
- Downloads Clang/LLVM toolchain

**Linux-specific step**: After `npm run init`, must run:
```bash
./src/build/install-build-deps.sh
```

This script (Chromium's official dependency installer):
- Installs system packages required for building
- Sets up library dependencies
- Configures development tools
- Works on Debian/Ubuntu (use `--unsupported` for other distros)

#### Phase 2: Patching

Brave applies custom patches from `brave-core/patches/`:
- Chromium modifications
- Feature additions
- Privacy enhancements
- Branding changes

**Tracked in**: `brave/patches/*.patchinfo` files

#### Phase 3: Build Configuration (`gn gen`)

Generates Ninja build files based on:
- Build type (Release, Debug, Component, Static)
- Target platform and architecture
- GN args from `.env` file or command line

#### Phase 4: Compilation (`autoninja`)

Compiles ~40,000+ source files:
- C++ compilation (using Clang)
- JavaScript bundling
- Resource processing
- Linking

**Time estimate**: 2-6 hours for full build, 20-40 minutes for incremental

### 3. Build Artifacts

After successful compilation:

**Main executable**: `out/Component/brave`
**Supporting files**:
- `*.so` - Shared libraries
- `*.pak` - Resource packages
- `locales/*.pak` - Language files
- `chrome_100_percent.pak`, `chrome_200_percent.pak` - UI resources

**Installer packages** (optional):
- `.deb` - Debian/Ubuntu packages
- `.rpm` - RedHat/Fedora packages
- AppImage - Universal Linux package

### 4. Multi-Stage Strategy

Our workflow splits the build because:

1. **Total time**: 4-10 hours (can approach 6-hour GitHub Actions limit)
2. **Network phase**: Initial download is I/O bound
3. **Compile phase**: CPU-intensive, can timeout
4. **Checkpoint system**: Resume from failure points

#### Stage Breakdown

| Stage | Primary Task | Est. Time | Checkpoint Location |
|-------|--------------|-----------|---------------------|
| 1 | `npm run init` + deps | 2-3h | After gclient sync + install-build-deps.sh |
| 2-4 | Compilation | 4-8h | Partial object files |
| 5-6 | Linking & packaging | 1-2h | Final artifacts |

### 5. Incremental Build Optimization

The workflow preserves:
- **`src/.gclient`** - Depot tools state
- **`src/out/Component/obj/`** - Compiled object files
- **`src/out/Component/gen/`** - Generated source files
- **Build markers** - Progress tracking

Not preserved (excluded from checkpoint):
- `.git/` directories - Can be re-fetched
- `*.o`, `*.a` debug intermediates (large)
- Temporary files

### 6. Key Differences from Windows

| Aspect | Windows | Linux |
|--------|---------|-------|
| Compiler | MSVC | Clang/GCC |
| Path limits | 260 characters | No limit |
| Build speed | Slower | Faster (typically) |
| Dependencies | Manual setup | install-build-deps.sh |
| Compression | 7zip | tar + zstd |
| Stages needed | 8 | 6 |

### 7. Linux-Specific Considerations

**Dependencies**:
- Must run `./src/build/install-build-deps.sh` after init
- Requires sudo access for system package installation
- Script works best on Debian/Ubuntu
- Other distros: use `--unsupported` flag

**Toolchain**:
- Uses Clang/LLVM (downloaded by Chromium)
- System GCC is not used directly
- All tools are hermetic (self-contained)

**Libraries**:
- Most dependencies are statically linked
- Some system libraries required at runtime (.so files)
- GTK3/GTK4 for UI (installed by install-build-deps.sh)

**Permissions**:
- Build runs as regular user
- Only dependency installation needs sudo
- Output files owned by build user

### 8. Build Configuration Options

#### Build Types

```bash
npm run build              # Component (default, fast incremental)
npm run build Release      # Optimized release build
npm run build Debug        # Debug symbols included
npm run build Static       # Statically linked (slower build, faster startup)
```

#### GN Args (in brave/.env)

```
is_official_build = true          # Full optimizations
enable_nacl = false               # Disable Native Client
is_component_build = false        # Static linking
symbol_level = 1                  # Minimal symbols
blink_symbol_level = 0           # No Blink symbols
use_sysroot = true                # Use Chromium's sysroot
```

### 9. Troubleshooting Build Issues

**Issue**: install-build-deps.sh fails
- **Solution**: Try with `--unsupported` flag for non-Debian/Ubuntu distros
- **Alternative**: Manually install dependencies listed in the script

**Issue**: Out of disk space
- **Symptom**: Build fails during compilation
- **Requirement**: ~100GB free space minimum
- **Built-in solution**: Workflow automatically removes unused tools (~25-30GB freed)
  - Removes: .NET, Android SDK, GHC, Java, Google Cloud SDK, Swift, CodeQL
  - Prunes Docker images
- **Additional solution**: Clean old build artifacts or use larger disk

**Issue**: Out of memory
- **Symptom**: Linker crashes or OOM killer activates
- **Requirement**: 16GB RAM recommended for parallel builds
- **Solution**: Reduce ninja parallelism with `NINJA_JOBS=4`

**Issue**: gclient sync fails
- **Causes**: Network timeouts, Git LFS issues
- **Solution**: Retry with `npm run sync -- --force`

**Issue**: Patches fail to apply
- **Symptom**: `npm run init` errors with patch conflicts
- **Cause**: Chromium version mismatch
- **Solution**: Ensure brave-core version matches expected Chromium version

**Issue**: Missing library at runtime
- **Symptom**: `error while loading shared libraries`
- **Solution**: Run `install-build-deps.sh` or install missing package

### 10. Performance Optimization

**Recommended system**:
- CPU: 16+ cores (Ryzen 9 / Core i9 / Threadripper)
- RAM: 32GB (16GB minimum)
- Storage: NVMe SSD with 120GB+ free
- Network: Fast internet for initial download

**GitHub Actions runner specs**:
- CPU: 2-4 cores
- RAM: 7GB
- Storage: 14GB SSD
- **Result**: Slower than local, but faster than Windows runners

**Build time comparison**:
| System | Full Build | Incremental |
|--------|------------|-------------|
| High-end workstation | 1-2h | 5-15m |
| Mid-range desktop | 3-5h | 20-30m |
| GitHub Actions (single stage) | Times out (>6h) | - |
| GitHub Actions (multi-stage) | 6-15h total | N/A |

### 11. Artifact Sizes

**Uncompressed build directory**: ~70-90GB
**Compressed checkpoint**: ~12-20GB (tar + zstd level 3)
**Final package**: ~150-200MB (tar.xz)
**AppImage** (if built): ~200-250MB

### 12. Linux Distribution Compatibility

The official build targets Ubuntu LTS. The built binary should work on:

✓ Ubuntu 20.04+
✓ Debian 11+
✓ Fedora 35+
✓ openSUSE Leap 15.4+
✓ Arch Linux (current)

May require additional libraries:
⚠️ Older distributions (Ubuntu 18.04, Debian 10)
⚠️ Minimal distributions without GUI libraries

### 13. System Requirements

From Brave's Linux Development Environment guide:

**Required**:
- Git v2.41+
- Python 3 (with python-is-python3)
- Node.js v24+
- build-essential package
- python-setuptools, python3-distutils

**Recommended**:
- 16GB+ RAM
- 120GB+ free disk space
- Fast CPU (8+ cores)
- Ubuntu 22.04 or 24.04

### 14. Comparison with Docker-Based Builds

| Aspect | This Workflow | Docker (ungoogled-chromium-portablelinux) |
|--------|---------------|-------------------------------------------|
| Setup | Native on runner | Docker container |
| Isolation | Process level | Container level |
| Complexity | Medium | High |
| Reproducibility | Good | Excellent |
| Build speed | Faster (native) | Slower (overhead) |
| Disk usage | Direct | Layered |

## References

- [Brave Linux Development Environment](https://github.com/brave/brave-browser/wiki/Linux-Development-Environment)
- [Brave Build Configuration](https://github.com/brave/brave-browser/wiki/Build-configuration)
- [Chromium Linux Build Instructions](https://chromium.googlesource.com/chromium/src/+/master/docs/linux/build_instructions.md)
- [GN Reference](https://gn.googlesource.com/gn/+/main/docs/reference.md)
- [Ninja Build System](https://ninja-build.org/manual.html)

