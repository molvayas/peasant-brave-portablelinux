# Peasant Brave Linux

Automated multi-stage GitHub Actions workflow for building Brave Browser on Linux (Ubuntu).

## Overview

This repository uses a sophisticated multi-stage build approach to compile Brave Browser on GitHub Actions runners, working around the 6-hour runner timeout limitation. The build is split into 6 sequential stages, each saving and restoring build state.

## Features

- **Multi-stage incremental builds** - Checkpoint and resume across multiple runner instances
- **Artifact persistence** - Intermediate build states saved between stages using tar+zstd compression
- **Automatic retry logic** - Robust artifact upload with 5 retry attempts
- **Version-tagged builds** - Uses Brave version tags for reproducible builds
- **Automatic releases** - Publishes built binaries to GitHub Releases
- **Linux optimizations** - Native tar/zstd compression, faster than Windows builds

## How It Works

### Workflow Structure

The workflow consists of:
1. **6 sequential build stages** (`build-1` through `build-6`)
2. **Checkpoint system** - Each stage saves progress if build isn't complete
3. **Resume capability** - Next stage downloads and continues from checkpoint
4. **Final packaging** - Last stage publishes release artifacts

### Build Stages

Each stage performs:
1. Downloads previous build state (if available)
2. Continues compilation from where it left off
3. Runs for up to 6 hours (GitHub Actions enforces this)
4. Either:
   - **Success**: Uploads final package and sets `finished: true`
   - **Timeout/Incomplete**: Compresses `src/` directory and uploads checkpoint

### Stage Action (`/.github/actions/stage/`)

The custom action manages:
- **Brave initialization**: Clones brave-core at specified version tag
- **Dependency setup**: Installs Linux build tools, runs `npm run init` to fetch Chromium
- **Incremental compilation**: Executes `npm run build` (component build)
- **State management**: Tracks progress with marker files (`build-stage.txt`)
- **Artifact handling**: Uploads intermediate states or final packages

## Usage

### Configure Version

Edit `brave_version.txt` to specify which Brave version to build:

```bash
echo "1.85.74" > brave_version.txt
git add brave_version.txt
git commit -m "Update Brave version to 1.85.74"
git push
```

### Trigger Build

**Method 1: Push to main branch**
```bash
# Modify brave_version.txt and push
echo "1.85.74" > brave_version.txt
git add brave_version.txt
git commit -m "Build Brave 1.85.74"
git push origin main
```

**Method 2: Workflow Dispatch**
1. Go to Actions tab
2. Select "Build Brave Browser (Linux)" workflow
3. Click "Run workflow"
4. Select branch and click "Run workflow"

The workflow **always** reads the version from `brave_version.txt` - there are no version parameters.

### Version Format

Use Brave's release version numbers from https://github.com/brave/brave-core/tags

**Format**: Version number without or with 'v' prefix (the action handles both)

Examples:
- `1.85.74` → clones tag `v1.85.74` ✓
- `v1.85.74` → clones tag `v1.85.74` ✓
- `1.71.121` → clones tag `v1.71.121` ✓

**Note**: The workflow uses `--depth=2` and `--no-history` flags to reduce download size.

## Build Output

Successful builds produce:
- `brave-browser-{version}-linux-x64.tar.xz` - Portable browser package

Artifacts are published to GitHub Releases automatically.

## Requirements

- GitHub repository with Actions enabled
- No additional setup required (all dependencies installed during workflow)

## Technical Details

### Build Environment

- **Runner**: `ubuntu-latest` (Ubuntu 22.04)
- **Node.js**: v20
- **Python**: 3.11
- **Build directory**: `/home/runner/brave-build`
- **Compression**: tar + zstd with level 3 for checkpoints

### Artifact Strategy

**Intermediate artifacts** (`build-artifact`):
- Contains compressed `src/` directory with build state
- Excludes: `.git/`, `*.o`, `*.a` files
- Retention: 1 day
- Compression: zstd level 3 with multi-threading

**Final artifacts** (`brave-browser-linux`):
- Contains portable browser tarball (tar.xz)
- Retention: 7 days
- Compression level: 0 (no additional compression)

### Environment Variables

Set during build:
- `PYTHONUNBUFFERED=1` - Immediate stdout output
- `GSUTIL_ENABLE_LUCI_AUTH=0` - Disable Google auth

### Linux-Specific Optimizations

1. **Automatic disk cleanup** - Removes unused tools (~25-30GB freed)
   - Deletes: .NET SDK, Android SDK, GHC, Java, Google Cloud SDK, Swift, CodeQL
   - Essential for fitting Brave build in GitHub Actions runners
2. **No path length issues** - Linux doesn't have the 260-character limit like Windows
3. **Faster builds** - Linux toolchain is typically faster than MSVC
4. **Better compression** - Native zstd support with multi-threading
5. **Fewer stages** - 6 stages vs 8 on Windows (builds complete faster)

## Comparison with Windows Build

| Aspect | Windows (peasant-brave-windows) | Linux (this repo) |
|--------|----------------------------------|-------------------|
| Stages | 8 | 6 |
| Compression | 7zip (slower) | tar+zstd (faster) |
| Build directory | C:\brave-build | /home/runner/brave-build |
| Path issues | Yes (260 char limit) | No |
| Build speed | Slower | Faster |
| Disk cleanup | Not needed (larger disk) | Automatic (~25-30GB freed) |
| Runner | windows-2022 | ubuntu-latest |

## Directory Structure

```
/home/runner/brave-build/          # Root build directory
├── src/                           # Source root (gclient workspace)
│   ├── brave/                     # brave-core repository
│   │   ├── package.json           # npm configuration
│   │   ├── DEPS                   # Dependency manifest
│   │   ├── patches/               # Chromium patches
│   │   └── ...
│   ├── chrome/                    # Chromium browser
│   ├── third_party/               # Third-party dependencies
│   ├── out/                       # Build output
│   │   └── Component/             # Component build artifacts
│   │       ├── brave              # Main executable
│   │       ├── *.so               # Shared libraries
│   │       ├── *.pak              # Resource packages
│   │       └── locales/           # Localized resources
│   └── .gclient                   # gclient configuration
└── build-stage.txt                # Build progress marker
```

## Troubleshooting

### Build Fails in Stage 1

- Check that the Brave version tag exists
- Verify network connectivity for Chromium downloads
- Review logs for `npm run init` errors
- Check disk space (needs ~80GB free)

### Build Times Out

- Each stage has 6-hour timeout (GitHub Actions enforced)
- If consistently timing out, increase number of stages in `main.yml`
- Linux builds are typically faster than Windows, so this is rare

### Artifact Upload Fails

- Action retries 5 times with 10-second delays
- Check GitHub Actions artifact storage limits
- Verify repository permissions

### Missing Dependencies

- All build dependencies are installed in the first stage
- If specific libraries are missing, add them to the `apt-get install` command in `index.js`

## Extending

### Add More Stages

To increase build stages (if needed):

```yaml
build-7:
  needs: build-6
  runs-on: ubuntu-latest
  steps:
    - name: Checkout
      uses: actions/checkout@v4
    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'
    - name: Set up Python 3.11
      uses: actions/setup-python@v5
      with:
        python-version: '3.11'
    - name: Setup Stage
      run: npm install
      working-directory: ./.github/actions/stage
    - name: Run Stage
      id: stage
      uses: ./.github/actions/stage
      with:
        finished: ${{ needs.build-6.outputs.finished }}
        from_artifact: true
  outputs:
    finished: ${{ steps.stage.outputs.finished }}
```

### Modify Build Configuration

Edit `index.js` to customize:
- Build type: Change `build` to `build Release` for optimized builds
- Build flags: Modify npm run build arguments
- Package contents: Adjust which files are included in the tarball

## References

- [Brave Browser Build Guide](https://github.com/brave/brave-browser/wiki)
- [Linux Development Environment](https://github.com/brave/brave-browser/wiki/Linux-Development-Environment)
- [Brave Core Repository](https://github.com/brave/brave-core)
- [Chromium Linux Build Instructions](https://chromium.googlesource.com/chromium/src/+/master/docs/linux/build_instructions.md)

## Related Projects

- **peasant-brave-windows**: Windows build using same multi-stage approach
- **ungoogled-chromium-windows**: Original inspiration for multi-stage builds
- **ungoogled-chromium-portablelinux**: Docker-based Chromium build for Linux

## License

This build automation is independent tooling. Brave Browser itself is licensed under MPL 2.0.

## Credits

- Inspired by the ungoogled-chromium multi-stage build approaches
- Adapted from peasant-brave-windows for cross-platform consistency

