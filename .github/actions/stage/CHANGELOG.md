# Changelog

All notable changes to the Brave Build Stage Action will be documented in this file.

## [2.0.0] - 2025-10-28

### Major Refactoring - Production Ready Architecture

This is a complete rewrite of the action with a focus on modularity, maintainability, and extensibility.

### Added

- **Modular Architecture**: Separated concerns into logical modules
  - `src/main.js`: Entry point
  - `src/orchestrator.js`: Build orchestration
  - `src/build/`: Platform-specific builders
  - `src/archive/`: Multi-volume archive operations
  - `src/utils/`: Reusable utilities
  - `src/config/`: Configuration management

- **Multi-Platform Support**: Added platform abstraction layer
  - Linux: Fully implemented
  - macOS: Placeholder for future implementation
  - Windows: Placeholder for future implementation
  - Factory pattern for creating platform-specific builders

- **Multi-Architecture Support**: Added architecture parameter
  - x64: Supported
  - arm64: Supported (framework in place)

- **Platform Input**: New `platform` input to specify target platform
- **Architecture Input**: New `arch` input to specify target architecture
- **Comprehensive Documentation**: README with architecture overview and usage examples
- **Type Safety**: Better structured code with clear interfaces
- **Error Handling**: Improved error handling throughout
- **Logging**: Structured logging with clear prefixes

### Changed

- **Main Entry Point**: Changed from `index.js` to `src/main.js`
- **Action Metadata**: Updated `action.yml` with new inputs and improved descriptions
- **Package Metadata**: Updated `package.json` with proper metadata
- **Configuration**: Moved all hardcoded values to `src/config/constants.js`

### Refactored

- **Build Logic**: Extracted into platform-specific classes
  - `LinuxBuilder`: Implements all Linux build stages
  - Future builders follow same interface

- **Archive Operations**: Separated into dedicated module
  - `createMultiVolumeArchive()`: Create and upload multi-volume archives
  - `extractMultiVolumeArchive()`: Download and extract multi-volume archives

- **Utilities**: Organized into focused modules
  - `exec.js`: Execution with timeout, sync operations
  - `disk.js`: Disk analysis and cleanup
  - `artifact.js`: Artifact management with retry logic

- **Code Structure**: 
  - Single-responsibility principle applied throughout
  - Dependency injection for testability
  - Clear separation between orchestration and implementation

### Technical Improvements

- **Better Error Handling**: Try-catch blocks with meaningful error messages
- **Logging Structure**: Consistent logging with component prefixes
- **Configuration Management**: Centralized configuration with type safety
- **Code Reusability**: DRY principle applied, shared utilities extracted
- **Maintainability**: Clear file structure makes it easy to find and modify code
- **Extensibility**: Easy to add new platforms/architectures following patterns

### Migration Notes

For users of the previous version (1.x):

1. The action interface remains backward compatible
2. New optional inputs (`platform`, `arch`) have sensible defaults
3. The old `index.js` is preserved as `index.js.backup` for reference
4. No workflow changes required unless you want to use new features

### Breaking Changes

None - the action interface is backward compatible.

### Performance

- Same runtime performance as previous version
- Improved code organization may slightly reduce cold start time
- No changes to the build or archiving logic that would affect performance

### Future Plans

- [ ] Implement macOS builder
- [ ] Implement Windows builder
- [ ] Add unit tests
- [ ] Add integration tests
- [ ] Support for custom build configurations
- [ ] Parallel builds for multiple architectures
- [ ] Cache optimization

## [1.0.0] - Previous Version

Initial working version with monolithic architecture.
- Single 1091-line `index.js` file
- Linux x64 support only
- Multi-volume archive support
- Checkpoint/resume functionality

