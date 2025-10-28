/**
 * Cleanup factory - creates appropriate cleanup for the platform
 */

const LinuxCleanup = require('./linux');
const MacOSCleanup = require('./macos');
const WindowsCleanup = require('./windows');

/**
 * Create a cleanup instance for the specified platform
 * @param {string} platform - Platform name (linux, macos, windows)
 * @returns {object} Platform-specific cleanup instance
 */
function createCleanup(platform) {
    const normalizedPlatform = platform.toLowerCase();
    
    switch (normalizedPlatform) {
        case 'linux':
            return new LinuxCleanup();
        case 'macos':
            return new MacOSCleanup();
        case 'windows':
            return new WindowsCleanup();
        default:
            throw new Error(`Unsupported platform: ${platform}. Supported platforms: linux, macos, windows`);
    }
}

module.exports = {
    createCleanup
};

