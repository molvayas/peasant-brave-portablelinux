# create_dist Implementation Summary

## ✅ What Was Implemented

Added proper **distribution package creation** for Release builds using Brave's built-in `create_dist` target.

## How It Works

### Component Builds (Default - Fast)
```bash
npm run build
```
- Builds to `out/Component/`
- Creates manual tarball/zip of output directory
- For testing and development

### Release Builds (Production - Proper Packages)
```bash
npm run build Release -- --target=create_dist --skip_signing
```
- Builds to `out/Release/`
- Creates distribution packages automatically
- Produces **unsigned** but properly packaged distributions
- Output: `out/Release/brave_dist/`

## Build Outputs

### Linux Release
- `Brave-v1.85.74-linux-x64.zip`
- Plus DEB/RPM packages (if configured)

### macOS Release
- `Brave-v1.85.74-darwin-x64.zip`
- Plus DMG/PKG installers (if configured)

### Windows Release
- `Brave-v1.85.74-win-x64.zip`
- Plus EXE installer (if configured)

## Code Changes

### 1. Build Command (`runBuild()`)

**All three builders updated:**
- `linux.js`
- `macos.js`
- `windows.js`

**Release builds now run:**
```javascript
if (this.buildType === 'Release') {
    buildArgs = ['run', 'build', 'Release', '--', '--target=create_dist', '--skip_signing'];
} else {
    buildArgs = ['run', 'build'];
}
```

### 2. Package Method (`package()`)

**All three builders updated to check buildType:**

```javascript
async package() {
    if (this.buildType === 'Release') {
        // Grab from brave_dist/
        const distZipPath = 'out/Release/brave_dist/Brave-v{version}-{platform}-{arch}.zip';
        // Copy to work directory
    } else {
        // Component: create manual tarball/zip
    }
}
```

**Features:**
- ✅ Looks for distribution packages in `brave_dist/`
- ✅ Falls back to listing directory if exact name doesn't match
- ✅ Finds any `.zip`, `.dmg`, or `.exe` files
- ✅ Copies to standardized name for artifacts

## Workflow Flow

```
┌─────────────────────────────────────────────────┐
│ User selects: Build type = Release              │
└─────────────────┬───────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────┐
│ Stage 1: npm run init                           │
└─────────────────┬───────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────┐
│ Stage 2-6: npm run build Release --             │
│            --target=create_dist --skip_signing  │
│                                                  │
│ This does:                                       │
│  1. Compiles browser (optimized)                │
│  2. Creates distribution packages                │
│  3. Outputs to: out/Release/brave_dist/         │
└─────────────────┬───────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────┐
│ Package stage:                                   │
│  - Finds: Brave-v1.85.74-{platform}-{arch}.zip  │
│  - Copies to work directory                     │
│  - Uploads as artifact                          │
└─────────────────────────────────────────────────┘
```

## Benefits

### ✅ Proper Distribution Format
- Uses Brave's official packaging system
- Correct directory structure
- All resources included
- Proper versioning

### ✅ Unsigned But Ready
- Skips signing (no keys needed)
- But creates proper installers
- Can be signed later if needed
- Ready for distribution

### ✅ Backward Compatible
- Component builds unchanged
- Existing workflows still work
- Only Release builds use create_dist

## File Locations

### During Build
- Source: `src/brave/`
- Build output: `src/out/Release/`
- Distribution packages: `src/out/Release/brave_dist/`

### After Packaging
- Final artifact: `workDir/brave-browser-{version}-{platform}-{arch}.zip`
- Uploaded to GitHub Actions artifacts
- Downloaded by collector job

## Testing

### To Test Component Build (unchanged):
```
Actions → Build Brave Browser → Run workflow
Build type: Component
```
**Expected**: Tarball/zip of output directory (current behavior)

### To Test Release Build (new):
```
Actions → Build Brave Browser → Run workflow
Build type: Release
```
**Expected**: 
1. Build logs show: "Running npm run build Release with create_dist (unsigned)..."
2. Package logs show: "Packaging Release build from brave_dist..."
3. Artifact is a proper distribution zip

## Troubleshooting

### "Distribution package not found"

**Check build logs for:**
```
out/Release/brave_dist/
```

**The script will list directory contents:**
```
Files in brave_dist: [
  'Brave-v1.85.74-linux-x64.zip',
  'other-files.txt'
]
```

**If no files found:**
- Build may have failed before create_dist
- Check earlier build logs for errors
- Verify `--target=create_dist` was passed

### Wrong filename format

**Script handles this gracefully:**
- Looks for expected name first
- Falls back to finding any .zip/.dmg/.exe
- Copies and renames to standardized format

### Skip signing not working

**Verify command in logs:**
```
Command: npm run build Release -- --target=create_dist --skip_signing
```

**The `--` is important** - it passes flags through npm to the build script.

## Next Steps

### To use these packages:

1. **Component builds**: Extract tarball, run `brave` binary
2. **Release builds**: Extract zip, run Brave installer/binary

### To sign packages later:

Remove `--skip_signing` and add signing configuration:
- Linux: Code signing certificates
- macOS: Apple Developer ID + notarization
- Windows: Authenticode certificate

See `RELEASE_BUILD.md` for signing setup.

## Files Modified

- `.github/actions/stage/src/build/linux.js`
  - `runBuild()` - Added create_dist for Release
  - `package()` - Check brave_dist/ for Release builds

- `.github/actions/stage/src/build/macos.js`
  - `runBuild()` - Added create_dist for Release
  - `package()` - Check brave_dist/ for Release builds

- `.github/actions/stage/src/build/windows.js`
  - `runBuild()` - Added create_dist for Release
  - `package()` - Check brave_dist/ for Release builds

## Status

✅ **COMPLETE AND READY TO TEST**

All platforms (Linux, macOS, Windows) now:
- Support Component builds (fast, manual packaging)
- Support Release builds (proper distribution packages, unsigned)
- Handle both x64 and arm64 architectures
- Gracefully fall back if exact filename differs

---

**Ready to push and test!** 🚀

