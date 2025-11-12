# Peasant Brave Portable Linux

Automated Brave Browser builds with custom patches. Target version: **v1.85.74**

## Structure

```
peasant-brave-portablelinux/
├── .github/          # GitHub Actions build workflows
├── patches/          # Custom Brave patches (6 patches)
├── scripts/          # Patch management scripts
├── series            # Patch application order
├── LICENSE-MPL       # For Brave modifications (001-003)
├── LICENSE-PROPRIETARY # For new files (004-006, transparency-only)
└── brave_version.txt # Target Brave version
```

## Patches

**MPL-2.0** (modifications of Brave):
- 001-003: Modify existing Brave files

**Transparency-Only** (new files):
- 004-006: Add custom files (read-only for human verification)

See patch headers: `head -n 6 patches/*.patch`

## Local Testing

```bash
# View patches
scripts/view-patches

# Apply patches (after cloning brave as sibling directory)
scripts/apply-patches

# Update version
scripts/update-brave-version v1.86.50
```

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

## GitHub Actions Build

Patches are automatically applied during the build process in `.github/actions/stage`.

## License

Dual-licensed:
- Modifications of Brave: MPL-2.0 (see LICENSE-MPL)
- New custom files: Transparency-Only (see LICENSE-PROPRIETARY)
