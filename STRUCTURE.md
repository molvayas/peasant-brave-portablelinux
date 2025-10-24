# Repository Structure

## Complete File Tree

```
peasant-brave-portablelinux/
├── .github/
│   ├── actions/
│   │   └── stage/
│   │       ├── action.yml          # Custom action definition
│   │       ├── index.js            # Main build orchestration logic (257 lines)
│   │       └── package.json        # Node.js dependencies
│   └── workflows/
│       └── main.yml                # 6-stage build workflow (179 lines)
│
├── .gitignore                      # Excludes build artifacts
├── brave_version.txt               # Version to build (v1.85.74)
│
├── README.md                       # User guide and quickstart
├── BUILD_NOTES.md                  # Technical build documentation
├── WORKFLOW_DESIGN.md              # Architecture and design decisions
├── PROJECT_SUMMARY.md              # This project overview
└── STRUCTURE.md                    # This file
```

## File Purposes

### GitHub Actions Files

#### `.github/workflows/main.yml`
- **Purpose**: Orchestrates the multi-stage build process
- **Triggers**: Push to main, workflow_dispatch
- **Stages**: 6 sequential build stages + 1 publish stage
- **Each stage**:
  - Checks out code
  - Sets up Node.js 24 and Python 3.11
  - Installs stage action dependencies
  - Runs custom stage action
  - Outputs completion status

#### `.github/actions/stage/action.yml`
- **Purpose**: Defines the custom stage action interface
- **Inputs**:
  - `finished`: Whether previous stage completed
  - `from_artifact`: Whether to resume from checkpoint
- **Outputs**:
  - `finished`: Whether this stage completed
- **Runtime**: Node.js 20

#### `.github/actions/stage/index.js`
- **Purpose**: Core build logic for each stage
- **Key functions**:
  - Read brave_version.txt for version info
  - Clone brave-core repository
  - Install base system dependencies
  - Run `npm run init` to fetch Chromium
  - Run `./src/build/install-build-deps.sh` (Linux-specific!)
  - Run `npm run build` to compile
  - Create checkpoint artifacts (tar+zstd)
  - Package final tarball
  - Upload artifacts with retry logic
- **State machine**: init → build → package → done
- **Linux optimizations**:
  - Native tar/zstd compression
  - Multi-threaded compression (-T0)
  - install-build-deps.sh for system packages

#### `.github/actions/stage/package.json`
- **Purpose**: Declares npm dependencies for the action
- **Dependencies**:
  - `@actions/artifact`: Artifact upload/download
  - `@actions/core`: Action inputs/outputs/logging
  - `@actions/exec`: Command execution
  - `@actions/glob`: File pattern matching
  - `@actions/io`: File operations

### Configuration Files

#### `brave_version.txt`
- **Purpose**: Specifies which Brave version to build
- **Format**: Version number (with or without 'v' prefix)
- **Examples**: `1.85.74` or `v1.85.74`
- **Usage**: Read by index.js to determine git tag to clone

#### `.gitignore`
- **Purpose**: Excludes build artifacts and temporary files
- **Excludes**:
  - `node_modules/` - npm packages
  - `src/` - Chromium source tree
  - `out/` - Build output
  - `build/` - Build working directory
  - `*.tar.zst`, `*.tar.xz` - Compressed archives
  - `.gclient`, `.gclient_entries` - gclient state

### Documentation Files

#### `README.md`
- **Audience**: End users and developers
- **Content**:
  - Overview of the project
  - How to configure and trigger builds
  - Build output and artifacts
  - Troubleshooting common issues
  - Comparison with Windows version
  - Technical details (6 stages, tar+zstd, etc.)

#### `BUILD_NOTES.md`
- **Audience**: Technical users and contributors
- **Content**:
  - Deep dive into Brave's build system
  - Build phases (init, patch, configure, compile)
  - Multi-stage strategy explanation
  - Linux-specific considerations
  - System requirements
  - Performance benchmarks
  - Troubleshooting guide

#### `WORKFLOW_DESIGN.md`
- **Audience**: Developers and architects
- **Content**:
  - Architecture overview
  - Design decisions (why 6 stages, why tar+zstd, etc.)
  - Comparison with Windows and ungoogled-chromium
  - Security considerations
  - Future enhancements
  - Scalability considerations

#### `PROJECT_SUMMARY.md`
- **Audience**: Project reviewers and stakeholders
- **Content**:
  - High-level overview of what was created
  - Key differences from Windows version
  - Linux-specific enhancements
  - Architecture consistency
  - Success criteria and completion status

#### `STRUCTURE.md` (this file)
- **Audience**: New developers joining the project
- **Content**:
  - Complete file tree
  - Purpose of each file
  - File size and line count information
  - Quick reference guide

## File Statistics

| File | Lines | Purpose |
|------|-------|---------|
| `.github/workflows/main.yml` | 179 | Workflow orchestration |
| `.github/actions/stage/index.js` | 257 | Build logic |
| `.github/actions/stage/action.yml` | 17 | Action interface |
| `.github/actions/stage/package.json` | 12 | npm dependencies |
| `brave_version.txt` | 1 | Version config |
| `.gitignore` | 13 | Git exclusions |
| `README.md` | ~300 | User documentation |
| `BUILD_NOTES.md` | ~400 | Technical docs |
| `WORKFLOW_DESIGN.md` | ~500 | Architecture docs |
| `PROJECT_SUMMARY.md` | ~350 | Project overview |
| `STRUCTURE.md` | ~200 | This structure guide |

**Total**: ~2,200 lines of code and documentation

## Key Design Patterns

### 1. State Machine
```
build-stage.txt contains: "init" | "build" | "package"
```

Each stage checks this marker to know where to resume.

### 2. Checkpoint/Resume
```
Stage N: Work → Save checkpoint → Upload artifact
Stage N+1: Download artifact → Extract → Continue from marker
```

### 3. Retry Logic
```javascript
for (let i = 0; i < 5; ++i) {
    try {
        await artifact.uploadArtifact(...);
        break;
    } catch (e) {
        await sleep(10000);
    }
}
```

### 4. Output Propagation
```yaml
build-N:
    outputs:
        finished: ${{ steps.stage.outputs.finished }}
build-N+1:
    needs: build-N
    with:
        finished: ${{ needs.build-N.outputs.finished }}
```

## Differences from peasant-brave-windows

| File | Windows | Linux |
|------|---------|-------|
| `index.js` | 346 lines, Windows-specific | 257 lines, Linux-specific |
| Stages | 8 | 6 |
| Compression | 7-Zip commands | tar + zstd |
| Extra step | None | install-build-deps.sh |
| Timeout handling | execWithTimeout function | GitHub-enforced |
| Build dir | `C:\brave-build` | `/home/runner/brave-build` |

## Quick Reference

### To Build a New Version
1. Edit `brave_version.txt`
2. Commit and push
3. Wait 6-15 hours
4. Download from Releases

### To Debug a Failed Build
1. Check Actions logs
2. Download `build-artifact` from failed stage
3. Extract and check `build-stage.txt`
4. Review last ~100 lines of logs for errors

### To Add a Stage
1. Copy `build-6` block in `main.yml`
2. Rename to `build-7`
3. Update `needs:` to reference `build-6`
4. Update `publish-release` to need `build-7`

### To Modify Build Type
In `index.js`, change:
```javascript
await exec.exec('npm', ['run', 'build'], ...)
```
To:
```javascript
await exec.exec('npm', ['run', 'build', 'Release'], ...)
```

## Related Files in Workspace

This project references:
- `brave-core/README.md` - Brave's official build guide
- `brave-browser/README.md` - Build system overview
- `brave-browser.wiki/Linux-Development-Environment.md` - Linux setup guide
- `brave-browser.wiki/Brave-Browser-Build-Deconstructed-‐-overview-of-the-underlying-tools.md` - Build internals
- `peasant-brave-windows/` - Windows counterpart
- `ungoogled-chromium-windows/` - Original multi-stage inspiration
- `ungoogled-chromium-portablelinux/` - Linux Docker approach

