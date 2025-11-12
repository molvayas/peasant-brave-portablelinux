# Patch System Integration

## Overview

Custom patches are automatically applied during GitHub Actions builds. For local development, use the scripts in `scripts/`.

## GitHub Actions Integration

**Files:** 
- `.github/actions/stage/src/build/linux.js`
- `.github/actions/stage/src/build/windows.js`
- `.github/actions/stage/src/build/macos.js`

**When:** After cloning brave-core, before `npm install`

**How:** The `_applyPatches()` method:
1. Checks if `patches/` and `series` exist
2. Sets up quilt environment variables (QUILT_PATCHES, QUILT_SERIES, QUILT_PC)
3. Applies all patches with `quilt push -a`:
   - **Linux:** quilt installed via apt-get
   - **Windows:** quilt installed via MSYS2 pacman
   - **macOS:** quilt installed via Homebrew
4. Fails the build if patches don't apply cleanly

**Unified approach:** All platforms now use quilt for consistency and robustness.

## Local Development

From this repo root:

```bash
# View patch status
scripts/view-patches

# Apply patches (assumes ../brave exists)
scripts/apply-patches

# Remove patches
scripts/unapply-patches

# Update Brave version
scripts/update-brave-version v1.86.50
```

**Note:** Local scripts expect `brave/` as a sibling directory to this repo.

## Version Management

- **brave_version.txt** - Target version (with 'v' prefix, e.g., `v1.85.74`)
- Used by GitHub Actions to clone the correct brave-core tag
- Update via `scripts/update-brave-version v1.86.50` or manually edit the file

## Patch Files

Located in `patches/`:
- `001-003.patch` - MPL-2.0 (modifications of Brave files)
- `004-006.patch` - Transparency-Only (new custom files)

Order defined in `series` file.

## Troubleshooting

**Build fails with patch errors:**
- Check if patches are compatible with current brave_version.txt
- Resolve conflicts manually on a local machine:
  ```bash
  cd ../brave
  export QUILT_PATCHES=/path/to/repo/patches QUILT_SERIES=/path/to/repo/series
  quilt push -f
  vim conflicted_file.cc
  rm *.rej
  quilt refresh
  ```

**Patches already applied error:**
- Raven's `.pc/` directory exists in brave-core from previous run
- GitHub Actions always clones fresh, so this shouldn't happen in CI
- For local: run `scripts/unapply-patches` first

