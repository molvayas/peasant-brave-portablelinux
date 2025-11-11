/**
 * Builder Factory - Platform abstraction for Brave browser builds
 *
 * This module implements the Factory design pattern to create platform-specific
 * builder instances that handle the unique requirements of each operating system.
 * The factory encapsulates platform detection and instantiation logic, providing
 * a clean abstraction layer for the build orchestrator.
 *
 * Why a factory pattern?
 * - Each platform (Linux, macOS, Windows) has unique build requirements
 * - Toolchains, paths, and commands differ significantly between platforms
 * - Error handling and timeout strategies vary by platform
 * - Single entry point simplifies platform extension
 *
 * Supported platforms:
 * - Linux: Native builds with system packages and GN/Ninja
 * - macOS: Xcode integration with Homebrew dependencies
 * - Windows: Visual Studio toolchain with PowerShell automation
 */

const LinuxBuilder = require('./linux');
const MacOSBuilder = require('./macos');
const WindowsBuilder = require('./windows');

/**
 * Create a platform-specific builder instance using the Factory pattern
 *
 * This function serves as the single entry point for builder creation across all
 * supported platforms. It normalizes platform names, validates inputs, and
 * instantiates the appropriate builder class with platform-specific configuration.
 *
 * The factory ensures that:
 * - Platform names are normalized (case-insensitive)
 * - Only supported platforms are accepted
 * - Each builder receives consistent parameters
 * - Platform-specific logic is encapsulated in builder classes
 *
 * @param {string} platform - Target platform identifier (case-insensitive)
 * @param {string} braveVersion - Brave browser version tag to build (e.g., "v1.50.100")
 * @param {string} arch - CPU architecture (default: "x64")
 * @returns {LinuxBuilder|MacOSBuilder|WindowsBuilder} Platform-specific builder instance
 * @throws {Error} If platform is not supported
 *
 * @example
 * ```javascript
 * const builder = createBuilder('linux', 'v1.50.100', 'x64');
 * // Returns LinuxBuilder instance configured for x64 builds
 * ```
 */
function createBuilder(platform, braveVersion, arch = 'x64') {
    // Normalize platform name to lowercase for case-insensitive matching
    const normalizedPlatform = platform.toLowerCase();

    // Factory pattern: instantiate the appropriate builder class based on platform
    // Each builder class encapsulates platform-specific build logic and dependencies
    switch (normalizedPlatform) {
        case 'linux':
            // Linux builds use system packages, GN/Ninja, and native toolchains
            return new LinuxBuilder(braveVersion, arch);

        case 'macos':
            // macOS builds integrate with Xcode and use Homebrew for dependencies
            return new MacOSBuilder(braveVersion, arch);

        case 'windows':
            // Windows builds use Visual Studio toolchain and PowerShell automation
            return new WindowsBuilder(braveVersion, arch);

        default:
            // Explicit error for unsupported platforms to catch configuration mistakes
            throw new Error(`Unsupported platform: ${platform}. Supported platforms: linux, macos, windows`);
    }
}

module.exports = {
    createBuilder
};

