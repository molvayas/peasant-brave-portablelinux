# Architecture Documentation

## Overview

The Brave Build Stage Action uses a modular, object-oriented architecture designed for maintainability, testability, and extensibility.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       GitHub Actions                        │
│                      (workflow runner)                      │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                        main.js                              │
│  • Reads action inputs                                      │
│  • Reads Brave version from file                            │
│  • Creates BuildOrchestrator                                │
│  • Handles top-level errors                                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   BuildOrchestrator                         │
│  • Coordinates entire build process                         │
│  • Manages build state (init → build → package)            │
│  • Handles checkpoint/resume logic                          │
│  • Manages artifact lifecycle                               │
└───────────┬─────────────────────────────────┬───────────────┘
            │                                 │
            ▼                                 ▼
┌─────────────────────────┐     ┌─────────────────────────────┐
│   Platform Builders     │     │   Archive Operations        │
│  • LinuxBuilder         │     │  • createMultiVolumeArchive │
│  • MacOSBuilder (stub)  │     │  • extractMultiVolumeArchive│
│  • WindowsBuilder (stub)│     │                             │
│                         │     │  Manages:                   │
│  Each implements:       │     │  • Volume creation          │
│  • initialize()         │     │  • Streaming compression    │
│  • runInit()            │     │  • Upload coordination      │
│  • runBuild()           │     │  • Download on-demand       │
│  • package()            │     │  • Volume cleanup           │
│  • getCurrentStage()    │     │                             │
│  • setStage()           │     │                             │
└───────────┬─────────────┘     └─────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Utility Modules                          │
│                                                             │
│  exec.js            disk.js             artifact.js        │
│  • execWithTimeout  • runNcduAnalysis   • uploadWithRetry  │
│  • calculateTimeout • cleanupDirs       • deleteArtifact   │
│  • waitAndSync      • showDiskUsage     • setupDebugFilter │
│                                                             │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│                   Configuration                             │
│                                                             │
│  constants.js                                               │
│  • PLATFORMS: Platform-specific configs                     │
│  • ARCHITECTURES: Architecture configs                      │
│  • TIMEOUTS: Build timeout settings                         │
│  • ARCHIVE: Archive/compression settings                    │
│  • STAGES: Build stage definitions                          │
│  • ARTIFACTS: Artifact naming                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### main.js (Entry Point)
**Responsibility**: Bootstrap the action
- Parse GitHub Actions inputs
- Read Brave version from repository file
- Create and run orchestrator
- Handle fatal errors

**Dependencies**: orchestrator.js, @actions/core

### orchestrator.js (Build Coordinator)
**Responsibility**: Orchestrate the build lifecycle
- Manage build state transitions
- Coordinate between builders and archive operations
- Handle checkpoint creation and restoration
- Manage artifact uploads/downloads

**Key Methods**:
- `run()`: Main entry point
- `_setupEnvironment()`: Initialize or restore build environment
- `_runBuildStages()`: Execute build stages
- `_packageAndUpload()`: Create and upload final artifact
- `_createCheckpoint()`: Save build state for resumption

**Dependencies**: build/factory, archive/multi-volume, utils/*, config/constants

### build/factory.js (Builder Factory)
**Responsibility**: Create platform-specific builders
- Validate platform parameter
- Return appropriate builder instance

**Pattern**: Factory Pattern

### build/linux.js (Linux Builder)
**Responsibility**: Implement Linux-specific build logic
- Install system dependencies
- Clone and initialize brave-core
- Execute build stages with proper timeouts
- Package final build

**Key Methods**:
- `initialize()`: Setup fresh build environment
- `runInit()`: Execute npm run init stage
- `runBuild()`: Execute npm run build with timeout
- `package()`: Create distribution package
- `getCurrentStage()`: Read build stage marker
- `setStage()`: Update build stage marker

**Dependencies**: @actions/exec, @actions/core, utils/*, config/constants

### build/macos.js & build/windows.js (Future Builders)
**Responsibility**: Placeholder for future platform support
- Same interface as LinuxBuilder
- Currently throws "not implemented" errors

### archive/multi-volume.js (Archive Manager)
**Responsibility**: Handle large archives split into volumes
- Create tar archives with multi-volume support
- Stream compression and upload
- Download and extract on-demand
- Minimize disk usage throughout process

**Key Functions**:
- `createMultiVolumeArchive()`: Create, compress, upload volumes
- `extractMultiVolumeArchive()`: Download and extract volumes
- Helper functions for script generation

**Implementation Details**:
- Uses tar -cM (multi-volume mode)
- Generates bash scripts that tar calls
- Scripts handle compression, upload, cleanup synchronously
- Final volume processed separately (tar only calls script BETWEEN volumes)

### utils/exec.js (Execution Utilities)
**Responsibility**: Command execution with advanced features
- `execWithTimeout()`: Run commands with Linux timeout command
- `calculateBuildTimeout()`: Calculate remaining time with safety margins
- `waitAndSync()`: Wait and sync filesystem

### utils/disk.js (Disk Utilities)
**Responsibility**: Disk management
- `runNcduAnalysis()`: Analyze disk usage with ncdu
- `cleanupDirectories()`: Remove unnecessary files
- `showDiskUsage()`: Display disk usage information

### utils/artifact.js (Artifact Utilities)
**Responsibility**: Artifact management
- `deleteArtifactSafely()`: Delete artifacts ignoring errors
- `cleanupPreviousArtifacts()`: Remove old checkpoint artifacts
- `uploadArtifactWithRetry()`: Upload with retry logic
- `setupDebugFilter()`: Filter debug messages from logs

### config/constants.js (Configuration)
**Responsibility**: Centralized configuration
- Platform-specific settings (runners, paths, dependencies)
- Architecture settings
- Timeout configurations
- Archive settings
- Stage definitions
- Artifact naming

**Key Exports**:
- `PLATFORMS`: Platform configurations
- `ARCHITECTURES`: Architecture configurations
- `getPlatformConfig()`: Get platform settings
- `getArchConfig()`: Get architecture settings
- `getBuildPaths()`: Get build paths for platform

## Data Flow

### Fresh Build Flow
```
main.js
  → reads inputs (finished=false, from_artifact=false)
  → reads brave_version.txt
  → creates BuildOrchestrator
    → creates LinuxBuilder
    → calls builder.initialize()
      → installs dependencies
      → clones brave-core
      → installs npm deps
    → calls builder.getCurrentStage() → "init"
    → calls builder.runInit()
      → runs npm run init
      → installs chromium deps
      → cleans up unnecessary files
      → sets stage to "build"
    → calls builder.runBuild()
      → calculates timeout
      → runs npm run build with timeout
      → if timeout: waits, syncs, returns
      → if success: sets stage to "package", returns
    → if timed out:
      → calls createMultiVolumeArchive()
        → creates tar volumes
        → compresses each volume
        → uploads each volume
        → creates manifest
      → sets output finished=false
```

### Resume from Checkpoint Flow
```
main.js
  → reads inputs (finished=false, from_artifact=true)
  → reads brave_version.txt
  → creates BuildOrchestrator
    → creates LinuxBuilder
    → calls extractMultiVolumeArchive()
      → downloads manifest
      → downloads first volume
      → runs tar -xM with script
        → script downloads subsequent volumes on-demand
        → script deletes previous volumes after use
    → calls builder.getCurrentStage() → "build"
    → calls builder.runBuild()
      → continues build from checkpoint
      → ...
```

### Successful Build Flow
```
... (build succeeds)
→ builder.runBuild() returns success=true
→ orchestrator calls builder.package()
  → creates tar.xz with browser files
  → returns package path
→ orchestrator calls uploadArtifactWithRetry()
  → uploads final artifact
  → sets retention to 7 days
→ sets output finished=true
→ next workflow stage sees finished=true and exits early
```

## Design Patterns

### Factory Pattern
- `build/factory.js` creates appropriate builder based on platform
- Allows easy addition of new platforms

### Strategy Pattern
- Each builder implements the same interface
- Orchestrator doesn't need to know platform details

### Template Method Pattern
- Orchestrator defines build flow skeleton
- Builders implement platform-specific steps

### Dependency Injection
- Builders receive configuration via constructor
- Utilities receive dependencies as parameters
- Makes testing easier

## Error Handling Strategy

### Levels of Error Handling

1. **Utility Level**: Individual functions handle their own errors
   - Return error codes or throw exceptions
   - Log detailed error information

2. **Builder Level**: Builders catch and handle stage errors
   - Return success/failure status
   - Don't throw exceptions for expected failures (timeouts)

3. **Orchestrator Level**: Orchestrator handles build lifecycle errors
   - Catches builder errors
   - Creates checkpoints on failure
   - Sets appropriate outputs

4. **Main Level**: Entry point handles fatal errors
   - Catches all exceptions
   - Calls core.setFailed()
   - Logs stack traces

### Retry Logic

- **Artifact Upload**: 5 retries with 10-second delays
- **Build Commands**: No automatic retry (handled by stage resumption)
- **Dependency Installation**: Continues on failure (some failures are acceptable)

## Extension Points

### Adding a New Platform

1. Add platform configuration to `config/constants.js`:
   ```javascript
   PLATFORMS.newplatform = {
     runner: 'newplatform-latest',
     workDir: '/path/to/work',
     // ...
   }
   ```

2. Create builder in `build/newplatform.js`:
   ```javascript
   class NewPlatformBuilder {
     // Implement required methods
   }
   ```

3. Register in `build/factory.js`:
   ```javascript
   case 'newplatform':
     return new NewPlatformBuilder(version, arch);
   ```

### Adding a New Utility

1. Create module in `utils/myutil.js`
2. Export functions
3. Import and use in builders or orchestrator

### Adding a New Build Stage

1. Add stage to `config/constants.js`:
   ```javascript
   STAGES.MYSTAGE = 'mystage'
   ```

2. Add stage method to builder:
   ```javascript
   async runMyStage() {
     // implementation
   }
   ```

3. Update orchestrator's `_runBuildStages()` to call new stage

## Testing Strategy (Future)

### Unit Tests
- Test individual utilities in isolation
- Mock external dependencies (@actions/exec, @actions/artifact)
- Test configuration functions

### Integration Tests
- Test builder implementations with mocked exec
- Test orchestrator with mocked builders
- Test archive operations with real tar

### End-to-End Tests
- Test complete workflow in GitHub Actions
- Use test repository with minimal build

## Performance Considerations

### Disk Space
- Multi-volume archives minimize disk usage
- Volumes deleted immediately after upload
- Source files removed during archive creation
- Unnecessary directories cleaned up after init

### Upload/Download
- Volumes uploaded immediately (no waiting for complete archive)
- Volumes downloaded on-demand during extraction
- Previous volumes deleted during extraction
- zstd compression reduces transfer size

### Build Time
- No overhead from refactoring (same build logic)
- Timeout handling prevents wasted CI time
- Checkpoint system allows efficient resumption

## Security Considerations

- No secrets in logs (debug filter removes sensitive output)
- Artifact retention limited (1 day for checkpoints, 7 for final)
- No arbitrary code execution (scripts are generated, not downloaded)
- Dependency versions pinned in package.json

## Monitoring and Debugging

### Logging Conventions
- `[Main]`: Main orchestration
- `[Tar]`: Tar operations
- `[Volume Script]`: Volume processing
- `[Extract]`: Extraction operations
- `[Download]`: Volume downloads
- `[Build]`: Build stage operations

### Key Metrics to Monitor
- Build stage durations
- Volume count and sizes
- Artifact upload/download times
- Disk usage at each stage
- Timeout occurrences

### Debug Mode
Set `ACTIONS_STEP_DEBUG=true` in workflow for additional debug output.

