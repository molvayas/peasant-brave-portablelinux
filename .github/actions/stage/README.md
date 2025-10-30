# Brave Build Stage Action

Multi-stage, multi-platform GitHub Action for building Brave with checkpoint, resume, and CI disk optimization.

## Atoms

- **Platforms**: linux (ready), macos/windows (planned)
- **Architectures**: x64, arm64
- **Stages**:
  1. init: prepare repo, fetch deps, clean
  2. build: compile browser
  3. package: tar+upload
- **Resumable**: multi-volume checkpoint, incremental upload/download
- **Disk**: streams, zstd compression, cleanup after upload/download
- **Config**: `src/config/constants.js`
- **Extend**: new builder in `src/build/`, register in factory
- **Inputs**: `finished`, `from_artifact`, `platform`, `arch`
- **Outputs**: `finished`
- **Directory**:
  - main: entry
  - orchestrator: controls run/resume/checkpoint
  - build/*: platform logic
  - archive/*: multi-volume, scripts
  - utils/*: exec, disk, artifact
  - config/*: constants

## Usage

```yaml
- uses: ./.github/actions/stage
  with:
    finished: false
    from_artifact: false
    platform: linux
    arch: x64
```
