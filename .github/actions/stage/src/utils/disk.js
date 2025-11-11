/**
 * Disk space management utilities for Brave browser builds
 *
 * This module provides targeted disk cleanup functionality specifically for the
 * Brave/Chromium source tree. Unlike the cleanup-disk GitHub Action (which removes
 * pre-installed runner tools), these utilities remove platform-irrelevant source
 * code after the build environment is initialized.
 *
 * Key use cases:
 * - Remove iOS/Android code when building for desktop platforms
 * - Free up disk space for the actual compilation process
 * - Reduce build times by eliminating unnecessary source processing
 */

const exec = require('@actions/exec');
const path = require('path');

/**
 * Clean up platform-irrelevant directories within the Brave/Chromium source tree
 *
 * This function removes unnecessary source directories to free up disk space for
 * the compilation process. Chromium is a multi-platform codebase containing code
 * for Windows, macOS, Linux, iOS, Android, etc. Building for one platform doesn't
 * require the source code for others.
 *
 * IMPORTANT DISTINCTION from cleanup-disk action:
 * - cleanup-disk: Removes GitHub Actions runner tools (runs at job start)
 * - This function: Removes Chromium platform code (runs after npm run init)
 *
 * Typical cleanup targets:
 * - 'ios': iOS-specific code (not needed for desktop builds)
 * - 'third_party/android_*': Android dependencies and tools
 * - 'third_party/jdk': Java Development Kit (not needed for C++ builds)
 *
 * @param {string} srcDir - Absolute path to source directory (e.g., '/home/runner/brave-build/src')
 * @param {string[]} cleanupPaths - Array of relative paths to remove, supports glob patterns
 * @returns {Promise<void>} Completes when cleanup is finished
 */
async function cleanupDirectories(srcDir, cleanupPaths) {
    console.log('\n=== Cleaning up unnecessary source directories ===');
    console.log(`Source directory: ${srcDir}`);
    console.log(`Paths to clean: ${cleanupPaths.join(', ')}`);

    // Process each cleanup path
    for (const relativePath of cleanupPaths) {
        // Handle glob patterns using bash expansion (e.g., 'third_party/android_*')
        // This allows patterns like 'android_*' to match 'android_sdk', 'android_tools', etc.
        if (relativePath.includes('*')) {
            const fullPattern = path.join(srcDir, relativePath);
            console.log(`🗑️  Removing glob pattern: ${fullPattern}`);
            // Use bash -c to enable glob expansion for rm command
            await exec.exec('bash', ['-c', `rm -rf ${fullPattern}`], {ignoreReturnCode: true});
        } else {
            // Direct path removal for non-glob patterns
            const fullPath = path.join(srcDir, relativePath);
            console.log(`🗑️  Removing directory: ${fullPath}`);
            await exec.exec('rm', ['-rf', fullPath], {ignoreReturnCode: true});
        }
    }

    console.log('\n📊 Checking disk space after cleanup...');
    const homeDir = process.env.HOME || '/home/runner';
    await exec.exec('df', ['-h', homeDir], {ignoreReturnCode: true});
    console.log('===========================================\n');
}

module.exports = {
    cleanupDirectories
};

