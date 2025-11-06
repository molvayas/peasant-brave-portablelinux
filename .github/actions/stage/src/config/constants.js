/**
 * Configuration constants for the Brave build action
 */

const path = require('path');

// Build timeouts (in milliseconds)
const TIMEOUTS = {
    // Global timeouts (used as fallback)
    MAX_BUILD_TIME: 4 * 60 * 60 * 1000,     // 4 hours (GitHub Actions limit is 6 hours)
    MIN_BUILD_TIME: 5 * 60 * 1000,          // 5 minutes minimum
    CLEANUP_WAIT: 10 * 1000,                // 10 seconds
    SYNC_WAIT: 10 * 1000,                   // 10 seconds
    
    // Platform-specific timeout overrides
    linux: {
        MAX_BUILD_TIME: 4 * 60 * 60 * 1000,  // 4 hours
        MIN_BUILD_TIME: 5 * 60 * 1000,       // 5 minutes
    },
    'linux-wsl': {
        MAX_BUILD_TIME: 5  * 60 * 1000,  // 5 hours (more time for WSL overhead + larger builds)
        MIN_BUILD_TIME: 5 * 60 * 1000,       // 5 minutes
    },
    macos: {
        MAX_BUILD_TIME: 4 * 60 * 60 * 1000,  // 4 hours
        MIN_BUILD_TIME: 5 * 60 * 1000,       // 5 minutes
    },
    windows: {
        MAX_BUILD_TIME: 4 * 60 * 60 * 1000,  // 4 hours
        MIN_BUILD_TIME: 10 * 60 * 1000,      // 10 minutes (Windows needs more time)
        FALLBACK_TIMEOUT: 15 * 60 * 1000,    // 15 minutes fallback
    }
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
        executable: 'brave',
        packageFormat: 'tar.xz',
        volumeSize: '2G',
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
    'linux-wsl': {
        runner: 'windows-latest',  // Runs on Windows with WSL
        workDir: '/home/runner/brave-build',  // WSL path
        nodeModulesCache: '/home/runner/.npm',
        executable: 'brave',
        packageFormat: 'tar.xz',
        volumeSize: '10G',  // Much larger volumes thanks to D: drive (145GB available)
        dependencies: [
            'build-essential', 'git', 'python3', 'python3-pip',
            'python-setuptools', 'python3-distutils', 'python-is-python3',
            'curl', 'lsb-release', 'sudo', 'tzdata', 'wget', 'ncdu', 'zstd'
        ],
        cleanupDirs: [
            'ios',
            'third_party/jdk',
            'third_party/android_*'
        ],
        // WSL-specific settings
        useNativeFilesystem: true,  // Use ext4 VHD on D: drive
        vhdSize: '140G',  // Virtual disk size
        vhdPath: '/mnt/d/wsl-vhd/brave-build.ext4'
    },
    macos: {
        runner: 'macos-latest',
        workDir: '/Users/runner/brave-build',
        nodeModulesCache: '/Users/runner/.npm',
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
    BUILD_DIST: 'build_dist',  // Release only: create distribution after browser build
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
 * Detect if running in WSL environment
 * @returns {boolean} True if running in WSL
 */
function isWSL() {
    // Check for WSL_DISTRO_NAME environment variable (set by setup-wsl action)
    if (process.env.WSL_DISTRO_NAME) {
        return true;
    }
    
    // Alternative: check if /proc/version contains "microsoft" or "WSL"
    try {
        const fs = require('fs');
        const procVersion = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return procVersion.includes('microsoft') || procVersion.includes('wsl');
    } catch (e) {
        return false;
    }
}

/**
 * Get platform configuration
 * @param {string} platform - Platform name (linux, macos, windows, linux-wsl)
 * @returns {object} Platform configuration
 */
function getPlatformConfig(platform) {
    let platformKey = platform.toLowerCase();
    
    // Auto-detect WSL for Linux platform
    if (platformKey === 'linux' && isWSL()) {
        console.log('🐧 Detected WSL environment - using linux-wsl configuration');
        platformKey = 'linux-wsl';
    }
    
    const config = PLATFORMS[platformKey];
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
 * @param {string} buildType - Build type (Component or Release)
 * @returns {object} Build paths
 */
function getBuildPaths(platform, buildType = 'Component') {
    const platformConfig = getPlatformConfig(platform);
    const workDir = platformConfig.workDir;
    // Use buildType for output directory name (Component or Release)
    const outputDirName = buildType;
    
    return {
        workDir,
        srcDir: path.join(workDir, 'src'),
        braveDir: path.join(workDir, 'src', 'brave'),
        outDir: path.join(workDir, 'src', 'out', outputDirName),
        markerFile: path.join(workDir, 'build-stage.txt')
    };
}

/**
 * Get platform-specific timeout configuration
 * @param {string} platform - Platform name (linux, macos, windows, linux-wsl)
 * @returns {object} Timeout configuration for the platform
 */
function getTimeouts(platform) {
    let platformKey = platform.toLowerCase();
    
    // Auto-detect WSL for Linux platform
    if (platformKey === 'linux' && isWSL()) {
        platformKey = 'linux-wsl';
    }
    
    const platformTimeouts = TIMEOUTS[platformKey];
    
    if (!platformTimeouts) {
        // Return global timeouts if platform-specific not found
        return {
            MAX_BUILD_TIME: TIMEOUTS.MAX_BUILD_TIME,
            MIN_BUILD_TIME: TIMEOUTS.MIN_BUILD_TIME,
            MIN_DIST_BUILD_TIME: TIMEOUTS.MIN_DIST_BUILD_TIME,
            CLEANUP_WAIT: TIMEOUTS.CLEANUP_WAIT,
            SYNC_WAIT: TIMEOUTS.SYNC_WAIT
        };
    }
    
    // Merge platform-specific with global defaults
    return {
        MAX_BUILD_TIME: platformTimeouts.MAX_BUILD_TIME || TIMEOUTS.MAX_BUILD_TIME,
        MIN_BUILD_TIME: platformTimeouts.MIN_BUILD_TIME || TIMEOUTS.MIN_BUILD_TIME,
        MIN_DIST_BUILD_TIME: platformTimeouts.MIN_DIST_BUILD_TIME || TIMEOUTS.MIN_DIST_BUILD_TIME,
        FALLBACK_TIMEOUT: platformTimeouts.FALLBACK_TIMEOUT, // Windows-specific
        CLEANUP_WAIT: TIMEOUTS.CLEANUP_WAIT,
        SYNC_WAIT: TIMEOUTS.SYNC_WAIT
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
    getBuildPaths,
    getTimeouts,
    isWSL
};

