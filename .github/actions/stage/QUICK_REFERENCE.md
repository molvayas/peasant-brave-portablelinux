# Quick Reference Guide

## File Structure at a Glance

```
src/
├── main.js              → Entry point, reads inputs
├── orchestrator.js      → Coordinates build lifecycle
├── build/
│   ├── factory.js       → Creates platform-specific builders
│   ├── linux.js         → Linux build implementation ✅
│   ├── macos.js         → macOS stub (TODO)
│   └── windows.js       → Windows stub (TODO)
├── archive/
│   ├── multi-volume.js  → Multi-volume orchestration
│   └── scripts/
│       ├── next-volume.sh          → Volume processing (create)
│       ├── upload-volume.js        → Upload helper
│       ├── next-volume-extract.sh  → Volume processing (extract)
│       └── download-volume.js      → Download helper
├── utils/
│   ├── exec.js          → Execution with timeout
│   ├── disk.js          → Disk analysis & cleanup
│   └── artifact.js      → Artifact management
└── config/
    └── constants.js     → All configuration
```

## Key Concepts

### Build Stages
```
init → build → package
  ↓      ↓        ↓
 npm   npm     create
 run   run     tar.xz
 init  build
```

### Checkpoint Flow
```
Build → Timeout → Sync → Archive → Compress → Upload
                                        ↓
Resume ← Extract ← Download ← Manifest
```

## Common Tasks

### Adding a Configuration Value

**File**: `src/config/constants.js`

```javascript
const MY_SETTING = {
    VALUE: 'something',
    TIMEOUT: 300
};

module.exports = {
    MY_SETTING,
    // ... other exports
};
```

### Adding a Utility Function

**File**: `src/utils/myutil.js`

```javascript
async function myFunction(param) {
    // implementation
}

module.exports = {
    myFunction
};
```

**Usage**:
```javascript
const {myFunction} = require('../utils/myutil');
await myFunction('value');
```

### Adding a Platform

1. **Config** (`src/config/constants.js`):
   ```javascript
   PLATFORMS.myplatform = {
       runner: 'myplatform-latest',
       workDir: '/path/to/work',
       // ...
   }
   ```

2. **Builder** (`src/build/myplatform.js`):
   ```javascript
   class MyPlatformBuilder {
       async initialize() { /* ... */ }
       async runInit() { /* ... */ }
       async runBuild() { /* ... */ }
       async package() { /* ... */ }
   }
   ```

3. **Factory** (`src/build/factory.js`):
   ```javascript
   case 'myplatform':
       return new MyPlatformBuilder(version, arch);
   ```

### Modifying Build Timeout

**File**: `src/config/constants.js`

```javascript
const TIMEOUTS = {
    MAX_BUILD_TIME: 300 * 60 * 1000,  // Change this (in ms)
    MIN_BUILD_TIME: 5 * 60 * 1000,    // Or this
};
```

### Changing Archive Volume Size

**File**: `src/config/constants.js`

```javascript
const ARCHIVE = {
    VOLUME_SIZE: '5G',  // GNU tar accepts human-readable sizes
    // '10G' = 10GB
    // '2G' = 2GB
    // '500M' = 500MB
};
```

### Adding a Cleanup Directory

**File**: `src/config/constants.js`

```javascript
PLATFORMS.linux = {
    // ...
    cleanupDirs: [
        'ios',
        'third_party/jdk',
        'my/new/dir',  // Add here
    ]
}
```

**Note**: This is for source tree cleanup (after npm run init).  
For runner cleanup, edit `.github/actions/cleanup-disk/index.js`.

## Workflow Integration

### Basic Usage
```yaml
- uses: ./.github/actions/stage
  with:
    finished: false
    from_artifact: false
```

### With Platform/Arch
```yaml
- uses: ./.github/actions/stage
  with:
    finished: false
    from_artifact: false
    platform: linux
    arch: x64
```

### Multi-Stage
```yaml
jobs:
  build-1:
    steps:
      - uses: ./.github/actions/stage
        with:
          finished: false
          from_artifact: false
    outputs:
      finished: ${{ steps.stage.outputs.finished }}

  build-2:
    needs: build-1
    steps:
      - uses: ./.github/actions/stage
        with:
          finished: ${{ needs.build-1.outputs.finished }}
          from_artifact: true
```

## Key Functions Reference

### Orchestrator Methods
```javascript
async run()                    // Main entry point
async _setupEnvironment()      // Setup or restore
async _runBuildStages()        // Run init/build stages
async _packageAndUpload()      // Create final artifact
async _createCheckpoint()      // Save build state
```

### Builder Interface
```javascript
async initialize()             // Fresh environment setup
async runInit()               // npm run init stage
async runBuild()              // npm run build stage
async package()               // Create distribution
async getCurrentStage()       // Read stage marker
async setStage(stage)         // Update stage marker
```

### Utility Functions
```javascript
// exec.js
execWithTimeout(cmd, args, opts)
calculateBuildTimeout(start, max, min)
waitAndSync(waitTime)

// disk.js
runNcduAnalysis(output, target)
cleanupDirectories(srcDir, paths)
showDiskUsage(message)

// artifact.js
uploadArtifactWithRetry(artifact, name, files, root, opts)
cleanupPreviousArtifacts(artifact, baseName)
deleteArtifactSafely(artifact, name)
```

## Log Prefixes

| Prefix | Component | Purpose |
|--------|-----------|---------|
| `[Main]` | orchestrator.js | Main coordination |
| `[Build]` | build/linux.js | Build operations |
| `[Tar]` | archive/multi-volume.js | Tar operations |
| `[Volume Script]` | Generated script | Volume processing |
| `[Extract]` | Generated script | Extraction |
| `[Download]` | Generated script | Volume download |

## Configuration Categories

### TIMEOUTS
- `MAX_BUILD_TIME`: Maximum time for build (5 hours)
- `MIN_BUILD_TIME`: Minimum timeout (5 minutes)
- `CLEANUP_WAIT`: Wait after timeout (10 seconds)
- `SYNC_WAIT`: Wait for filesystem sync (10 seconds)

### ARCHIVE
- `VOLUME_SIZE`: Size per volume ('5G' for 5GB)
- `COMPRESSION_LEVEL`: zstd level (3)
- `MAX_VOLUMES`: Max volumes to delete (20)
- `RETENTION_DAYS`: Checkpoint retention (1 day)
- `FINAL_RETENTION_DAYS`: Final artifact retention (7 days)

### PLATFORMS
- `runner`: GitHub Actions runner
- `workDir`: Build working directory
- `nodeModulesCache`: npm cache location
- `outputDirName`: Build output directory
- `executable`: Main executable name
- `packageFormat`: Distribution format
- `dependencies`: System packages to install
- `cleanupDirs`: Directories to remove after init

### STAGES
- `INIT`: 'init'
- `BUILD`: 'build'
- `PACKAGE`: 'package'

## Error Handling Flow

```
Utility Level
    ↓ (returns error or throws)
Builder Level
    ↓ (returns {success, timedOut})
Orchestrator Level
    ↓ (catches errors, creates checkpoint)
Main Level
    ↓ (core.setFailed())
GitHub Actions
```

## Debugging Checklist

- [ ] Check log prefix to identify component
- [ ] Verify stage marker file contents
- [ ] Check disk space before/after operations
- [ ] Verify artifact was uploaded
- [ ] Check volume count in manifest
- [ ] Enable ACTIONS_STEP_DEBUG for more logs
- [ ] Compare behavior with index.js.backup

## Performance Tips

1. **Disk Space**: Cleanup runs automatically, no action needed
2. **Upload Speed**: Volumes upload in parallel with compression
3. **Download Speed**: Volumes download on-demand during extraction
4. **Build Speed**: Same as before, no overhead from refactoring
5. **Timeout**: Adjust MAX_BUILD_TIME if builds consistently timeout

## Common Issues & Solutions

### Issue: Build times out too early
**Solution**: Increase `TIMEOUTS.MAX_BUILD_TIME` in constants.js

### Issue: Artifacts too large
**Solution**: 
1. Check `cleanupDirs` in platform config
2. Reduce `ARCHIVE.VOLUME_SIZE_BLOCKS` for more volumes

### Issue: Need more build logs
**Solution**: Add debug logging in builder methods

### Issue: Platform not supported
**Solution**: Implement platform builder following linux.js pattern

### Issue: Want to test without full build
**Solution**: Mock builder in orchestrator for testing

## Best Practices

1. **Don't modify generated scripts** directly (modify generators in multi-volume.js)
2. **Add new configs to constants.js** (don't hardcode)
3. **Follow existing naming conventions** (use camelCase for JS)
4. **Add JSDoc comments** for exported functions
5. **Test locally** before pushing (npm install && check syntax)
6. **Update README** when adding features
7. **Use existing utilities** before creating new ones
8. **Handle errors gracefully** (try-catch where appropriate)
9. **Log meaningful messages** (include context)
10. **Keep functions focused** (single responsibility)

## File Size Guidelines

- Utility functions: < 100 lines each
- Builder methods: < 150 lines each
- Config objects: < 50 lines each
- Main entry point: < 100 lines
- Orchestrator: < 250 lines
- Archive operations: < 700 lines (complex logic)

## Testing Strategy

### Manual Testing
1. Run action in workflow
2. Check logs for errors
3. Verify artifacts
4. Test checkpoint/resume

### Unit Testing (Future)
```javascript
describe('LinuxBuilder', () => {
    it('should initialize', async () => {
        // test
    });
});
```

### Integration Testing (Future)
```javascript
describe('BuildOrchestrator', () => {
    it('should create checkpoint on timeout', async () => {
        // test
    });
});
```

## Need More Help?

- **Usage**: See `README.md`
- **Architecture**: See `ARCHITECTURE.md`
- **Changes**: See `CHANGELOG.md`
- **Workflow**: See `WORKFLOW_NOTES.md`
- **Original Code**: See `index.js.backup`

