/**
 * Disk utilities for cleanup and analysis
 */

const exec = require('@actions/exec');
const path = require('path');

/**
 * Run ncdu to analyze disk usage and export to JSON
 * @param {string} outputPath - Path to save the ncdu JSON output
 * @param {string} targetDir - Directory to analyze (default: /)
 * @returns {Promise<number>} Exit code
 */
async function runNcduAnalysis(outputPath, targetDir = '/') {
    console.log(`Running ncdu analysis on ${targetDir}...`);
    console.log(`Output will be saved to: ${outputPath}`);
    
    // Verify ncdu is available
    const whichCode = await exec.exec('bash', ['-c', 'which ncdu'], {ignoreReturnCode: true});
    if (whichCode !== 0) {
        console.log('⚠️ ncdu not found, attempting to install...');
        await exec.exec('sudo', ['apt-get', 'update'], {ignoreReturnCode: true});
        await exec.exec('sudo', ['apt-get', 'install', '-y', 'ncdu'], {ignoreReturnCode: true});
    }
    
    const exitCode = await exec.exec('bash', ['-c', `ncdu -x -o "${outputPath}" "${targetDir}"`], {
        ignoreReturnCode: true
    });
    
    if (exitCode === 0) {
        console.log(`✓ ncdu analysis completed: ${outputPath}`);
    } else {
        console.log(`⚠️ ncdu analysis failed with code ${exitCode}`);
    }
    
    return exitCode;
}

/**
 * Clean up directories within the Brave/Chromium source tree to free disk space
 * 
 * NOTE: This is different from the cleanup-disk action:
 * - cleanup-disk action: Removes pre-installed tools from GitHub Actions runner (runs at job start)
 * - This function: Removes unnecessary platform code from Brave source (runs after npm run init)
 * 
 * @param {string} srcDir - Source directory (e.g., /home/runner/brave-build/src)
 * @param {string[]} cleanupPaths - Relative paths to clean up (e.g., ['ios', 'third_party/android_*'])
 */
async function cleanupDirectories(srcDir, cleanupPaths) {
    console.log('\n=== Cleaning up unnecessary source directories ===');
    
    for (const relativePath of cleanupPaths) {
        // Handle glob patterns (e.g., android_*)
        if (relativePath.includes('*')) {
            const fullPattern = path.join(srcDir, relativePath);
            console.log(`Removing ${fullPattern}...`);
            await exec.exec('bash', ['-c', `rm -rf ${fullPattern}`], {ignoreReturnCode: true});
        } else {
            const fullPath = path.join(srcDir, relativePath);
            console.log(`Removing ${fullPath}...`);
            await exec.exec('rm', ['-rf', fullPath], {ignoreReturnCode: true});
        }
    }
    
    console.log('Checking disk space after cleanup:');
    await exec.exec('df', ['-h', '/home/runner'], {ignoreReturnCode: true});
    console.log('===========================================\n');
}

/**
 * Show disk usage information
 * @param {string} message - Message to display
 */
async function showDiskUsage(message = 'Disk usage') {
    console.log(`\n=== ${message} ===`);
    await exec.exec('df', ['-h'], {ignoreReturnCode: true});
    console.log('===========================================\n');
}

module.exports = {
    runNcduAnalysis,
    cleanupDirectories,
    showDiskUsage
};

