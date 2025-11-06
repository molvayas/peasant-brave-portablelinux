# WSL-Specific Configuration

## Overview

The build system now automatically detects WSL environments and uses optimized settings for Windows runners with larger disk space.

## Key Changes

### 1. Separate Configuration (`constants.js`)

Added `linux-wsl` platform configuration with WSL-optimized settings:

- **Volume Size**: `10G` (vs `2G` for native Linux)
  - Leverages the larger D: drive (145GB available)
  - Reduces number of archive volumes needed
  - Faster uploads with fewer files

- **Virtual Disk**: `140G` ext4 filesystem
  - Mounted at `/home/runner/brave-build`
  - Native Linux I/O performance
  - Located on D: drive for maximum space

### 2. Auto-Detection

The system automatically detects WSL by checking:
1. `WSL_DISTRO_NAME` environment variable (set by `setup-wsl` action)
2. `/proc/version` for "microsoft" or "WSL" strings

When detected, it automatically switches from `linux` to `linux-wsl` configuration.

### 3. Volume Size Comparison

| Environment | Volume Size | Max Volumes | Total Capacity |
|-------------|-------------|-------------|----------------|
| Native Linux | 2G | 20 | ~40GB |
| **WSL** | **10G** | **20** | **~200GB** |
| macOS | 7G | 20 | ~140GB |

### 4. Build Output

When running in WSL, you'll see:

```
=== Initializing Linux Build Environment ===
Brave version: 1.73.104
Architecture: x64
Build type: Component
Work directory: /home/runner/brave-build
🐧 Running in WSL environment
Volume size for archives: 10G (larger due to D: drive space)
Virtual disk: 140G ext4 filesystem
```

## Files Modified

1. **`.github/actions/stage/src/config/constants.js`**
   - Added `linux-wsl` platform configuration
   - Added `isWSL()` detection function
   - Updated `getPlatformConfig()` for auto-detection

2. **`.github/actions/stage/src/build/linux.js`**
   - Added WSL detection property
   - Enhanced initialization logging
   - Shows WSL-specific configuration

3. **`.github/workflows/builder-docker-linux.yml`**
   - Fixed `GITHUB_OUTPUT` path translation
   - Added `WSLENV` configuration for proper variable passing
   - Ensures artifact uploads work from WSL

## Benefits

✅ **5x larger archive volumes** - Fewer files to manage  
✅ **Automatic detection** - No manual configuration needed  
✅ **Native performance** - ext4 filesystem on Windows  
✅ **Backward compatible** - Native Linux still uses 2G volumes  
✅ **Clear logging** - Shows which mode is active

## Testing

The configuration has been tested with:
- ✅ WSL detection working correctly
- ✅ 10G volume sizes being used
- ✅ Artifact uploads functioning properly
- ✅ GITHUB_OUTPUT properly passed to WSL

## Future Enhancements

Potential improvements:
- Adjust `MAX_VOLUMES` based on available space
- Dynamic volume sizing based on disk usage
- WSL-specific timeout adjustments

