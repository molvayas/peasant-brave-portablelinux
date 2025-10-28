# Cleanup Disk Action

Multi-platform GitHub Action to free up disk space by removing unnecessary tools and packages from GitHub Actions runners.

## Features

- **Multi-Platform Support**: Linux, macOS, Windows
- **Modular Architecture**: Clean separation by platform
- **Comprehensive Cleanup**: Removes ~15-20GB on Linux, ~95GB on macOS
- **Safe Operations**: All removals use `ignoreReturnCode` to prevent failures

## Usage

### Basic (Linux - Default)
```yaml
- uses: ./.github/actions/cleanup-disk
```

### Specify Platform
```yaml
- uses: ./.github/actions/cleanup-disk
  with:
    platform: macos  # or linux, windows
```

### In Matrix Workflow
```yaml
strategy:
  matrix:
    platform: [linux, macos]

steps:
  - uses: ./.github/actions/cleanup-disk
    with:
      platform: ${{ matrix.platform }}
```

## What It Removes

### Linux
- .NET SDK (~2GB)
- Android SDK (~4GB)
- Java JDKs (~1GB)
- Haskell/GHC (~1GB)
- Old Python versions (~2GB)
- Old Node versions (~1GB)
- Old Go versions (~1GB)
- Julia, Swift, PowerShell
- Google Chrome, Firefox
- Docker images
- **Total: ~15-20GB**

### macOS
- iOS Simulator Runtime (~32GB)
- xrOS Simulator Runtime (~30GB)
- watchOS Simulator Runtime (~17GB)
- tvOS Simulator Runtime (~16GB)
- Android SDK
- Spotlight indexing (disabled)
- **Total: ~95GB**

### Windows
- TODO: Not yet implemented

## Structure

```
cleanup-disk/
├── src/
│   ├── main.js           # Entry point
│   └── cleanup/
│       ├── factory.js    # Platform factory
│       ├── linux.js      # Linux cleanup
│       ├── macos.js      # macOS cleanup
│       └── windows.js    # Windows stub
├── action.yml
├── package.json
└── index.js.backup      # Original implementation
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `platform` | Target platform (linux, macos, windows) | No | `linux` |

## Example Output

### Linux
```
=== Runner Disk Space Cleanup (Linux) ===
BEFORE cleanup:
  Available: 14G

Removing .NET SDK...
  After: 16G
Removing Android SDK...
  After: 20G
...

FINAL disk space available:
  Available: 30G
```

### macOS
```
=== Runner Disk Space Cleanup (macOS) ===
BEFORE cleanup:
  Available: 60G

Disabling Spotlight indexing...
Removing iOS Simulator Runtime (~32 GB)...
  After: 92G
Removing xrOS Simulator Runtime (~30 GB)...
  After: 122G
...

FINAL disk space available:
  Available: 155G
```

## Development

Install dependencies:
```bash
cd .github/actions/cleanup-disk
npm install
```

Test syntax:
```bash
node -c src/main.js
node -c src/cleanup/linux.js
node -c src/cleanup/macos.js
```

## Adding New Cleanup Items

### For Linux
Edit `src/cleanup/linux.js`:
```javascript
const cleanupDirs = [
    // ... existing items
    {path: '/path/to/remove', name: 'Description'},
];
```

### For macOS
Edit `src/cleanup/macos.js`:
```javascript
const cleanupDirs = [
    // ... existing items
    {path: '/path/to/remove', name: 'Description'},
];
```

## Migration from v1

**v1** (Separate actions):
- `cleanup-disk/` for Linux
- `cleanup-disk-macos/` for macOS

**v2** (Unified):
- `cleanup-disk/` for all platforms
- Use `platform` input to specify

**Backward compatible**: Default is `linux`, so existing workflows work unchanged.

## License

MIT

