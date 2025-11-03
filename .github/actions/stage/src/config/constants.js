/**
 * Configuration constants for the Brave build action
 */

const path = require('path');

// Build timeouts (in milliseconds)
const TIMEOUTS = {
    MAX_BUILD_TIME: 240 * 60 * 1000, // 4.33 hours
    MIN_BUILD_TIME: 5 * 60 * 1000,   // 5 minutes
    CLEANUP_WAIT: 10 * 1000,          // 10 seconds
    SYNC_WAIT: 10 * 1000              // 10 seconds
};

// Archive configuration
const ARCHIVE = {
    COMPRESSION_LEVEL: 3,
    MAX_VOLUMES: 20,
    RETENTION_DAYS: 1,
    FINAL_RETENTION_DAYS: 7
};

// Platform-specific configurations
const PLATFORMS = {
    linux: {
        runner: 'ubuntu-latest',
        workDir: '/home/runner/brave-build',
        nodeModulesCache: '/home/runner/.npm',
        outputDirName: 'Component',
        executable: 'brave',
        packageFormat: 'tar.xz',
        volumeSize: '7G',
        dependencies: [
            'build-essential', 'git', 'python3', 'python3-pip',
            'python-setuptools', 'python3-distutils', 'python-is-python3',
            'curl', 'lsb-release', 'sudo', 'tzdata', 'wget', 'ncdu', 'zstd'
        ],
        cleanupDirs: [
            'ios',
            'third_party/jdk',
            'third_party/android_*'
        ]
    },
    macos: {
        runner: 'macos-latest',
        workDir: '/Users/runner/brave-build',
        nodeModulesCache: '/Users/runner/.npm',
        outputDirName: 'Component',
        executable: 'Brave Browser.app',
        packageFormat: 'tar.xz',
        volumeSize: '7G',
        tarCommand: 'gtar',  // Use GNU tar on macOS
        dependencies: [],  // Installed via brew in builder
        cleanupDirs: [
            'ios',
            'third_party/jdk',
            'third_party/android_*'
        ]
    },
    windows: {
        runner: 'windows-latest',
        workDir: 'D:\\brave-build',
        nodeModulesCache: 'C:\\Users\\runner\\.npm',
        outputDirName: 'Component',
        executable: 'brave.exe',
        packageFormat: 'zip',
        archiveCommand: '7z',  // Use 7-Zip for archiving
        dependencies: [],  // No pre-installation needed on Windows
        cleanupDirs: [
            'ios',
            'third_party/jdk'
        ]
    }
};

// Architecture configurations
const ARCHITECTURES = {
    x64: {
        gnArch: 'x64',
        suffix: 'x64'
    },
    arm64: {
        gnArch: 'arm64',
        suffix: 'arm64'
    },
    x86: {
        gnArch: 'x86',
        suffix: 'x86'
    }
};

// Build stages
const STAGES = {
    INIT: 'init',
    BUILD: 'build',
    PACKAGE: 'package'
};

// Artifact names
const ARTIFACTS = {
    BUILD_STATE: 'build-artifact',
    FINAL_PACKAGE: 'brave-browser',
    DISK_USAGE_BEFORE: 'disk-usage-before',
    DISK_USAGE_AFTER: 'disk-usage-after'
};

/**
 * Get platform configuration
 * @param {string} platform - Platform name (linux, macos, windows)
 * @returns {object} Platform configuration
 */
function getPlatformConfig(platform) {
    const config = PLATFORMS[platform.toLowerCase()];
    if (!config) {
        throw new Error(`Unsupported platform: ${platform}`);
    }
    return config;
}

/**
 * Get architecture configuration
 * @param {string} arch - Architecture name (x64, arm64, x86)
 * @returns {object} Architecture configuration
 */
function getArchConfig(arch) {
    const config = ARCHITECTURES[arch.toLowerCase()];
    if (!config) {
        throw new Error(`Unsupported architecture: ${arch}`);
    }
    return config;
}

/**
 * Get paths for the build
 * @param {string} platform - Platform name
 * @returns {object} Build paths
 */
function getBuildPaths(platform) {
    const platformConfig = getPlatformConfig(platform);
    const workDir = platformConfig.workDir;
    
    return {
        workDir,
        srcDir: path.join(workDir, 'src'),
        braveDir: path.join(workDir, 'src', 'brave'),
        outDir: path.join(workDir, 'src', 'out', platformConfig.outputDirName),
        markerFile: path.join(workDir, 'build-stage.txt')
    };
}

module.exports = {
    TIMEOUTS,
    ARCHIVE,
    PLATFORMS,
    ARCHITECTURES,
    STAGES,
    ARTIFACTS,
    getPlatformConfig,
    getArchConfig,
    getBuildPaths
};

