/**
 * Builder factory - creates appropriate builder for the platform
 */

const LinuxBuilder = require('./linux');
const MacOSBuilder = require('./macos');
const WindowsBuilder = require('./windows');

/**
 * Create a builder for the specified platform
 * @param {string} platform - Platform name (linux, macos, windows)
 * @param {string} braveVersion - Brave version to build
 * @param {string} arch - Architecture (x64, arm64, x86)
 * @returns {object} Platform-specific builder instance
 */
function createBuilder(platform, braveVersion, arch = 'x64') {
    const normalizedPlatform = platform.toLowerCase();
    
    switch (normalizedPlatform) {
        case 'linux':
            return new LinuxBuilder(braveVersion, arch);
        case 'macos':
            return new MacOSBuilder(braveVersion, arch);
        case 'windows':
            return new WindowsBuilder(braveVersion, arch);
        default:
            throw new Error(`Unsupported platform: ${platform}. Supported platforms: linux, macos, windows`);
    }
}

module.exports = {
    createBuilder
};

