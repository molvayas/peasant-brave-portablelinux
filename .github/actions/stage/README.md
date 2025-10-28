# Brave Build Stage Action

A production-ready, multi-stage GitHub Action for building Brave Browser with support for multiple platforms and architectures.

## Features

- **Multi-Stage Builds**: Automatically resumes builds across multiple GitHub Actions runs
- **Multi-Platform Support**: Linux (implemented), macOS (planned), Windows (planned)
- **Multi-Architecture Support**: x64, arm64
- **Checkpoint/Resume**: Uses multi-volume artifacts to save build state and resume
- **Disk Space Optimization**: Streaming compression and cleanup to work within CI disk constraints
- **Production-Ready**: Clean separation of concerns, proper error handling, extensive logging

## Architecture

### Directory Structure

```
.github/actions/stage/
├── src/
│   ├── main.js                 # Entry point
│   ├── orchestrator.js         # Build orchestration logic
│   ├── build/
│   │   ├── factory.js          # Builder factory
│   │   ├── linux.js            # Linux-specific build logic
│   │   ├── macos.js            # macOS build logic (stub)
│   │   └── windows.js          # Windows build logic (stub)
│   ├── archive/
│   │   ├── multi-volume.js     # Multi-volume tar operations (orchestration)
│   │   └── scripts/
│   │       ├── next-volume.sh          # Volume processing during creation
│   │       ├── upload-volume.js        # Upload helper
│   │       ├── next-volume-extract.sh  # Volume processing during extraction
│   │       └── download-volume.js      # Download helper
│   ├── utils/
│   │   ├── exec.js             # Execution utilities (timeout, sync)
│   │   ├── disk.js             # Disk analysis and cleanup
│   │   └── artifact.js         # Artifact management utilities
│   └── config/
│       └── constants.js        # Configuration constants
├── action.yml                  # Action metadata
├── package.json               # Dependencies
└── README.md                  # This file
```

### Component Overview

#### `main.js`
Entry point that reads inputs and creates the orchestrator.

#### `orchestrator.js`
Coordinates the entire build process:
- Environment setup (fresh or from artifact)
- Stage progression (init → build → package)
- Artifact management
- Error handling

#### `build/`
Platform-specific build implementations:
- **factory.js**: Creates appropriate builder for the platform
- **linux.js**: Complete Linux build implementation
- **macos.js**: Placeholder for macOS support
- **windows.js**: Placeholder for Windows support

Each builder implements:
- `initialize()`: Setup build environment
- `runInit()`: Run npm run init stage
- `runBuild()`: Run npm run build stage
- `package()`: Create final distribution package
- `getCurrentStage()`: Get current build stage
- `setStage()`: Update build stage marker

#### `archive/`
Multi-volume archive operations for checkpoint/resume:
- **multi-volume.js**: Orchestrates archive creation and extraction
- **scripts/**: Dedicated bash and node scripts for volume processing
  - `next-volume.sh`: Called by tar during archive creation
  - `upload-volume.js`: Uploads compressed volumes with retry
  - `next-volume-extract.sh`: Called by tar during extraction
  - `download-volume.js`: Downloads and decompresses volumes on-demand
- Creates tar archives split into 5GB volumes
- Streams compression and upload to minimize disk usage
- Downloads and extracts volumes on-demand during restoration

#### `utils/`
Reusable utility functions:
- **exec.js**: Command execution with timeout, sync operations
- **disk.js**: Disk analysis (ncdu), cleanup operations
- **artifact.js**: Artifact upload/download with retry logic

#### `config/`
Configuration management:
- Platform-specific settings (dependencies, paths, etc.)
- Timeout configurations
- Archive settings
- Build stage definitions

## Usage

### Basic Usage

```yaml
- name: Run Build Stage
  uses: ./.github/actions/stage
  with:
    finished: false
    from_artifact: false
    platform: linux
    arch: x64
```

### Multi-Stage Workflow

```yaml
jobs:
  build-1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm install
        working-directory: ./.github/actions/stage
      - name: Run Stage
        id: stage
        uses: ./.github/actions/stage
        with:
          finished: false
          from_artifact: false
          platform: linux
          arch: x64
    outputs:
      finished: ${{ steps.stage.outputs.finished }}

  build-2:
    needs: build-1
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm install
        working-directory: ./.github/actions/stage
      - name: Run Stage
        id: stage
        uses: ./.github/actions/stage
        with:
          finished: ${{ needs.build-1.outputs.finished }}
          from_artifact: true
          platform: linux
          arch: x64
    outputs:
      finished: ${{ steps.stage.outputs.finished }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `finished` | If previous stage finished the build, skip execution | Yes | `false` |
| `from_artifact` | Resume build from checkpoint artifact | Yes | `false` |
| `platform` | Target platform (linux, macos, windows) | No | `linux` |
| `arch` | Target architecture (x64, arm64) | No | `x64` |

## Outputs

| Output | Description |
|--------|-------------|
| `finished` | Whether the build has finished successfully |

## Build Stages

The build process consists of three stages:

### 1. Init Stage
- Clones brave-core repository
- Runs `npm run init` to download Chromium and dependencies
- Installs system build dependencies
- Cleans up unnecessary files (iOS, Android SDKs, etc.)

### 2. Build Stage
- Runs `npm run build` to compile the browser
- Has a configurable timeout (5 hours max, 5 minutes min)
- Automatically resumes if timed out

### 3. Package Stage
- Creates distribution package (tar.xz for Linux)
- Uploads final artifact

## Checkpoint System

When a build stage doesn't complete:

1. **Sync**: Waits and syncs filesystem to ensure all writes are flushed
2. **Archive**: Creates multi-volume tar archive with source files removed as they're added
3. **Compress**: Each volume is compressed with zstd
4. **Upload**: Each compressed volume is uploaded immediately
5. **Cleanup**: Volumes are deleted after upload to free disk space

When resuming:

1. **Manifest**: Downloads and reads archive manifest
2. **First Volume**: Downloads and decompresses first volume
3. **Extract**: Runs `tar -xM` which calls a script to download subsequent volumes on-demand
4. **Cleanup**: Previous volumes are deleted as new ones are downloaded

## Configuration

Platform and architecture-specific settings are in `src/config/constants.js`:

```javascript
const PLATFORMS = {
  linux: {
    runner: 'ubuntu-latest',
    workDir: '/home/runner/brave-build',
    dependencies: [...],
    cleanupDirs: [...]
  },
  // ...
};
```

## Extending for New Platforms

To add support for a new platform:

1. **Add configuration** in `src/config/constants.js`:
   ```javascript
   PLATFORMS.myplatform = {
     runner: 'myplatform-latest',
     workDir: '/path/to/build',
     // ...
   };
   ```

2. **Create builder** in `src/build/myplatform.js`:
   ```javascript
   class MyPlatformBuilder {
     async initialize() { /* ... */ }
     async runInit() { /* ... */ }
     async runBuild() { /* ... */ }
     async package() { /* ... */ }
   }
   ```

3. **Register in factory** in `src/build/factory.js`:
   ```javascript
   case 'myplatform':
     return new MyPlatformBuilder(braveVersion, arch);
   ```

## Development

### Testing Locally

1. Install dependencies:
   ```bash
   cd .github/actions/stage
   npm install
   ```

2. Run tests (when implemented):
   ```bash
   npm test
   ```

### Debugging

The action provides extensive logging:
- `[Main]`: Main orchestration messages
- `[Tar]`: Tar archive creation messages
- `[Volume Script]`: Volume processing messages
- `[Extract]`: Extraction messages
- `[Download]`: Volume download messages

Set `ACTIONS_STEP_DEBUG=true` in your workflow for additional debug output.

## Migration from Old Version

The old monolithic `index.js` has been refactored into a modular structure. The original file is preserved as `index.js.backup` for reference.

Key changes:
- Modular architecture with clear separation of concerns
- Platform abstraction for future macOS/Windows support
- Improved error handling and logging
- Better configuration management
- More testable code structure

## License

MIT

## Contributing

Contributions are welcome! When adding new features:

1. Follow the existing code structure
2. Add appropriate error handling
3. Include logging for debugging
4. Update this README
5. Consider backward compatibility

