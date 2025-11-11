/**
 * Configuration Constants for Brave Browser Multi-Platform Build System
 *
 * This module centralizes all configuration constants, platform-specific settings,
 * and utility functions for the Brave browser build action. It serves as the
 * single source of truth for build parameters across Linux, macOS, and Windows.
 *
 * Key responsibilities:
 * - Platform-specific configurations (runners, paths, dependencies)
 * - Build timeouts optimized for each platform's performance characteristics
 * - Archive settings for checkpoint/resume functionality
 * - Cross-platform path resolution and environment detection
 *
 * Why centralized configuration?
 * - Ensures consistency across all platform builders
 * - Makes platform extensions easier (add new platform = add to this file)
 * - Provides single location for tuning build parameters
 * - Enables dynamic configuration based on detected environments (WSL, etc.)
 */

const path = require('path');

// ============================================================================
// BUILD TIMEOUTS (in milliseconds)
// ============================================================================
// Timeout configurations optimized for each platform's build characteristics and
// GitHub Actions runner performance. These ensure builds complete within the
// 6-hour Actions limit while allowing sufficient time for each platform.
const TIMEOUTS = {
    // Global fallback timeouts (used when platform-specific not available)
    MAX_BUILD_TIME: 4 * 60 * 60 * 1000,     // 4 hours (well under 6-hour Actions limit)
    MIN_BUILD_TIME: 5 * 60 * 1000,          // 5 minutes minimum (prevent too-short timeouts)
    CLEANUP_WAIT: 10 * 1000,                // 10 seconds for process cleanup
    SYNC_WAIT: 10 * 1000,                   // 10 seconds for filesystem sync

    // Platform-specific timeout overrides based on empirical performance data
    linux: {
        MAX_BUILD_TIME: (5 * 60 * 60 + 20 * 60) * 1000,  // 5h 20m - Ubuntu runners are fast
        MIN_BUILD_TIME: 5 * 60 * 1000,       // 5 minutes
    },
    // not published
    'linux-wsl': {
        MAX_BUILD_TIME: (10 * 60) * 1000, 
        MIN_BUILD_TIME: 5 * 60 * 1000,       // 5 minutes
    },
    macos: {
        MAX_BUILD_TIME: (5 * 60 * 60 + 20 * 60) * 1000,
        MIN_BUILD_TIME: 5 * 60 * 1000,
    },
    windows: {
        MAX_BUILD_TIME: (4 * 60 * 60 + 30 * 60) * 1000,  // 7z takes much more time than gnu-tar
        MIN_BUILD_TIME: 10 * 60 * 1000,
        FALLBACK_TIMEOUT: 15 * 60 * 1000,
    }
};

// ============================================================================
// ARCHIVE CONFIGURATION
// ============================================================================
// Settings for the multi-volume archive system used for checkpoint/resume functionality.
// Chromium builds can exceed 100GB, requiring split archives that fit within GitHub's
// 100MB artifact size limit (before compression).
const ARCHIVE = {
    COMPRESSION_LEVEL: 3,        // Zstandard compression level (1-22, higher = better compression but slower)
    MAX_VOLUMES: 40,             // Maximum number of 2GB volumes (80GB total before compression)
    RETENTION_DAYS: 1,           // Checkpoint artifacts kept for 1 day (short-term)
    FINAL_RETENTION_DAYS: 7      // Final build artifacts kept for 1 week (GitHub default)
};

// ============================================================================
// PLATFORM-SPECIFIC CONFIGURATIONS
// ============================================================================
// Comprehensive platform settings defining runners, paths, dependencies, and
// build characteristics for each supported operating system. These configurations
// abstract away platform differences and provide consistent interfaces to builders.
const PLATFORMS = {
    // ========================================================================
    // LINUX CONFIGURATIONS
    // ========================================================================

    // Native Linux builds using Ubuntu runners
    linux: {
        workDir: '/home/runner/brave-build',        // Working directory for build
        nodeModulesCache: '/home/runner/.npm',      // npm cache location
        executable: 'brave',                         // Expected binary name
        packageFormat: 'tar.xz',                     // XZ-compressed tar (best compression)
        volumeSize: '2G',                           // 2GB archive volumes
        dependencies: [                              // Ubuntu packages for Chromium build
            'build-essential', 'git', 'python3', 'python3-pip',
            'python-setuptools', 'python3-distutils', 'python-is-python3',
            'curl', 'lsb-release', 'sudo', 'tzdata', 'wget', 'zstd'
        ],
        cleanupDirs: [                              // Platform-irrelevant source to remove
            'ios',                                  // iOS-specific code
            'third_party/jdk',                      // Java Development Kit
            'third_party/android_*'                 // Android dependencies
        ],
        enableGdu: true                             // Enable disk analysis with gdu
    },

    // Linux builds running under Windows Subsystem for Linux

    // The situation with free disk space on Linux runners is critical.
    // We have a WSL-based builder that builds on a virtual ext4 filesystem,
    // but this is very slow and prob not gonna get published unless needed.
    'linux-wsl': {
        workDir: '/home/runner/brave-build',        // WSL filesystem path
        nodeModulesCache: '/home/runner/.npm',      // npm cache in WSL
        executable: 'brave',
        packageFormat: 'tar.xz',
        volumeSize: '10G',                         // Larger volumes due to D: drive space (145GB)
        dependencies: [                             // Same Ubuntu packages as native Linux
            'build-essential', 'git', 'python3', 'python3-pip',
            'python-setuptools', 'python3-distutils', 'python-is-python3',
            'curl', 'lsb-release', 'sudo', 'tzdata', 'wget', 'zstd'
        ],
        cleanupDirs: [                             // Same cleanup as native Linux
            'ios',
            'third_party/jdk',
            'third_party/android_*'
        ],
        // WSL-specific filesystem optimizations
        useNativeFilesystem: true,                 // Use ext4 VHD instead of Windows NTFS
        vhdSize: '140G',                          // Large virtual disk for builds
        vhdPath: '/mnt/d/wsl-vhd/brave-build.ext4', // Path to VHD file on Windows D: drive
        enableGdu: true                           // Enable disk analysis in WSL environment
    },

    // ========================================================================
    // MACOS CONFIGURATIONS
    // ========================================================================

    macos: {
        workDir: '/Users/runner/brave-build',        // macOS home directory structure
        nodeModulesCache: '/Users/runner/.npm',      // npm cache location
        executable: 'Brave Browser.app',             // macOS .app bundle
        packageFormat: 'tar.xz',                     // XZ-compressed tar
        volumeSize: '7G',                           // Medium-sized volumes
        tarCommand: 'gtar',                         // GNU tar (gtar) instead of BSD tar
        dependencies: [],                           // Dependencies installed via Homebrew in builder
        cleanupDirs: [                              // Platform-irrelevant source to remove
            'ios',                                  // iOS code (though macOS and iOS share some)
            'third_party/jdk',                      // Java Development Kit
            'third_party/android_*'                 // Android dependencies
        ],
        enableGdu: true                            // Enable disk analysis with gdu
    },

    // ========================================================================
    // WINDOWS CONFIGURATIONS
    // ========================================================================

    windows: {
        workDir: 'D:\\brave-build',                  // Use D: drive for better performance/space
        nodeModulesCache: 'C:\\Users\\runner\\.npm', // npm cache on C: drive (system)
        executable: 'brave.exe',                     // Windows executable
        packageFormat: 'zip',                        // Standard Windows ZIP format
        archiveCommand: '7z',                        // 7-Zip for compression (better than built-in)
        dependencies: [],                           // Pre-installed Visual Studio Build Tools
        cleanupDirs: [                              // Platform-irrelevant source to remove
            'ios',                                  // iOS-specific code
            'third_party/jdk'                       // Java Development Kit (minimal cleanup on Windows)
        ],
        enableGdu: false                           // Disable gdu (not reliable on Windows runners)
    }
};

// ============================================================================
// ARCHITECTURE CONFIGURATIONS
// ============================================================================
// CPU architecture mappings between human-readable names and GN build system identifiers.
// GN (Generate Ninja) is Chromium's meta-build system that needs specific architecture names.
const ARCHITECTURES = {
    x64: {
        gnArch: 'x64',     // GN build system identifier for x86-64
        suffix: 'x64'      // Suffix used in directory names and artifacts
    },
    arm64: {
        gnArch: 'arm64',   // GN identifier for ARM 64-bit
        suffix: 'arm64'    // Suffix for ARM64 builds
    },
    x86: {
        gnArch: 'x86',     // GN identifier for 32-bit x86
        suffix: 'x86'      // Suffix for 32-bit builds (Windows only)
    }
};

// ============================================================================
// BUILD STAGES
// ============================================================================
// The three phases of the Brave build process. These stages correspond to the
// multi-stage GitHub Actions workflow that enables checkpoint/resume functionality.
const STAGES = {
    INIT: 'init',     // Stage 1: Environment setup and dependency installation
    BUILD: 'build',   // Stage 2: Chromium compilation (most time-consuming)
    PACKAGE: 'package' // Stage 3: Create distributable artifacts
};

// ============================================================================
// ARTIFACT NAMES
// ============================================================================
// Standardized naming convention for GitHub Actions artifacts used in the
// checkpoint/resume system and final build delivery.
const ARTIFACTS = {
    BUILD_STATE: 'build-artifact',        // Checkpoint artifacts (platform-specific)
    FINAL_PACKAGE: 'brave-browser',       // Final build deliverables
    DISK_USAGE_BEFORE: 'disk-usage-before', // Pre-build disk analysis (deprecated)
    DISK_USAGE_AFTER: 'disk-usage-after'    // Post-build disk analysis (deprecated)
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Detect if the current environment is Windows Subsystem for Linux (WSL)
 *
 * WSL detection is crucial because it affects which platform configuration to use.
 * When running in WSL, we use 'linux-wsl' config instead of 'linux' for optimized
 * filesystem and performance settings.
 *
 * Detection methods (in order of preference):
 * 1. WSL_DISTRO_NAME environment variable (set by setup-wsl action)
 * 2. /proc/version file containing "microsoft" or "wsl" strings
 *
 * @returns {boolean} True if running in WSL environment, false otherwise
 */
function isWSL() {
    // Primary detection: Environment variable set by setup-wsl GitHub Action
    if (process.env.WSL_DISTRO_NAME) {
        return true;
    }

    // Fallback detection: Check /proc/version for WSL signatures
    try {
        const fs = require('fs');
        const procVersion = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return procVersion.includes('microsoft') || procVersion.includes('wsl');
    } catch (e) {
        // /proc/version not readable (not Linux/WSL) or other error
        return false;
    }
}

/**
 * Get platform-specific configuration with automatic WSL detection
 *
 * This function resolves platform names to their configurations, with special
 * handling for WSL environments. When 'linux' is requested but WSL is detected,
 * it automatically switches to 'linux-wsl' configuration for optimal performance.
 *
 * @param {string} platform - Platform name (linux, macos, windows, linux-wsl)
 * @returns {object} Complete platform configuration object
 * @throws {Error} If platform is not supported
 */
function getPlatformConfig(platform) {
    let platformKey = platform.toLowerCase();

    // Auto-detect WSL for Linux platform and switch to optimized config
    if (platformKey === 'linux' && isWSL()) {
        console.log('LINUX: Detected WSL environment - using linux-wsl configuration');
        platformKey = 'linux-wsl';
    }

    const config = PLATFORMS[platformKey];
    if (!config) {
        throw new Error(`Unsupported platform: ${platform}. Supported: ${Object.keys(PLATFORMS).join(', ')}`);
    }
    return config;
}

/**
 * Get architecture configuration for GN build system
 *
 * Maps human-readable architecture names to GN (Generate Ninja) build system
 * identifiers. GN requires specific architecture names for cross-compilation.
 *
 * @param {string} arch - Architecture name (x64, arm64, x86)
 * @returns {object} Architecture configuration with GN identifiers
 * @throws {Error} If architecture is not supported
 */
function getArchConfig(arch) {
    const config = ARCHITECTURES[arch.toLowerCase()];
    if (!config) {
        throw new Error(`Unsupported architecture: ${arch}. Supported: ${Object.keys(ARCHITECTURES).join(', ')}`);
    }
    return config;
}

/**
 * Generate build paths based on platform and build type
 *
 * Creates a standardized directory structure for builds that adapts to different
 * platforms and build configurations. The output directory name follows Chromium's
 * convention of using the build type (Component/Release) as the directory name.
 *
 * @param {string} platform - Target platform (affects base paths)
 * @param {string} buildType - Build type (Component or Release, affects output dir)
 * @returns {object} Path configuration object with all required directories
 */
function getBuildPaths(platform, buildType = 'Component') {
    const platformConfig = getPlatformConfig(platform);
    const workDir = platformConfig.workDir;

    // Chromium uses buildType as output directory name (Component/Release)
    const outputDirName = buildType;

    return {
        workDir,                                    // Base working directory
        srcDir: path.join(workDir, 'src'),         // Chromium source root
        braveDir: path.join(workDir, 'src', 'brave'), // Brave-specific code
        outDir: path.join(workDir, 'src', 'out', outputDirName), // Build output
        markerFile: path.join(workDir, 'build-stage.txt') // Stage persistence
    };
}

/**
 * Get platform-specific timeout configuration
 *
 * Returns timeout settings optimized for each platform's build performance.
 * Includes automatic WSL detection to use appropriate timeout values.
 *
 * @param {string} platform - Platform name (linux, macos, windows, linux-wsl)
 * @returns {object} Timeout configuration with platform-optimized values
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
            CLEANUP_WAIT: TIMEOUTS.CLEANUP_WAIT,
            SYNC_WAIT: TIMEOUTS.SYNC_WAIT
        };
    }

    // Merge platform-specific settings with global defaults
    return {
        MAX_BUILD_TIME: platformTimeouts.MAX_BUILD_TIME || TIMEOUTS.MAX_BUILD_TIME,
        MIN_BUILD_TIME: platformTimeouts.MIN_BUILD_TIME || TIMEOUTS.MIN_BUILD_TIME,
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

