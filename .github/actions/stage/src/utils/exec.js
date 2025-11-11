/**
 * Command execution utilities with timeout and synchronization support
 *
 * This module provides robust command execution utilities specifically designed
 * for long-running build processes in GitHub Actions. It handles timeout management,
 * platform-specific command differences, and filesystem synchronization to ensure
 * reliable builds that can span multiple workflow stages.
 *
 * Key capabilities:
 * - Cross-platform timeout handling (Linux timeout vs macOS gtimeout)
 * - Intelligent timeout calculation based on job elapsed time
 * - Graceful process termination with SIGINT before SIGKILL
 * - Filesystem synchronization for data integrity
 */

const exec = require('@actions/exec');

/**
 * Execute a command with timeout protection using platform-specific timeout utilities
 *
 * This function provides reliable timeout handling for long-running build commands.
 * It uses the system's timeout command with graceful shutdown (SIGINT first, then SIGKILL)
 * to prevent builds from hanging indefinitely and exceeding GitHub Actions limits.
 *
 * Platform-specific timeout commands:
 * - Linux: `timeout` (from coreutils)
 * - macOS: `gtimeout` (GNU timeout from coreutils, installed via brew)
 *
 * Timeout behavior:
 * - Sends SIGINT (Ctrl+C equivalent) after timeout expires
 * - Escalates to SIGKILL after 5 additional minutes if process doesn't respond
 * - Returns exit code 124 on timeout (standard timeout command convention)
 *
 * @param {string} command - The command to execute
 * @param {string[]} args - Array of command arguments
 * @param {object} options - Execution options
 * @param {string} options.cwd - Working directory for command execution
 * @param {number} options.timeoutSeconds - Timeout in seconds
 * @param {boolean} options.useGTimeout - Force use of gtimeout (for macOS compatibility)
 * @returns {Promise<number>} Exit code (0 = success, 124 = timeout, other = command error)
 */
async function execWithTimeout(command, args, options = {}) {
    const {cwd, timeoutSeconds, useGTimeout = false} = options;
    
    console.log(`Running: ${command} ${args.join(' ')}`);
    console.log(`Timeout: ${(timeoutSeconds / 60).toFixed(0)} minutes (${(timeoutSeconds / 3600).toFixed(2)} hours)`);
    
    // Use gtimeout on macOS (from coreutils), timeout on Linux
    // -k 5m: Send SIGKILL if process doesn't die within 5 minutes after initial signal
    // -s INT: Send SIGINT (graceful, like Ctrl+C) as initial signal
    // Exit code 124: timeout occurred
    const timeoutCmd = useGTimeout ? 'gtimeout' : 'timeout';
    const timeoutArgs = [
        '-k', '5m',           // Kill after 5 min if not responding
        '-s', 'INT',          // Send SIGINT first (graceful)
        `${timeoutSeconds}s`, // Timeout in seconds
        command,
        ...args
    ];
    
    const exitCode = await exec.exec(timeoutCmd, timeoutArgs, {
        cwd: cwd,
        ignoreReturnCode: true
    });
    
    if (exitCode === 124) {
        console.log(`TIMEOUT: Timeout reached after ${(timeoutSeconds / 60).toFixed(0)} minutes`);
    }
    
    return exitCode;
}

/**
 * Calculate intelligent timeout values based on job elapsed time and GitHub Actions limits
 *
 * This function prevents builds from exceeding GitHub Actions' 6-hour timeout by dynamically
 * calculating remaining time and applying safety margins. It's crucial for the multi-stage
 * build system where each stage needs to fit within the remaining job time.
 *
 * Timeout calculation logic:
 * 1. Calculate elapsed time since job start
 * 2. Subtract from maximum allowed build time
 * 3. Apply minimum timeout floor to prevent too-short timeouts
 * 4. Convert to seconds for timeout command compatibility
 *
 * Used by platform builders to ensure builds complete before GitHub Actions kills the job.
 *
 * @param {number} jobStartTime - Job start timestamp (Date.now() from orchestrator)
 * @param {number} maxBuildTime - Maximum build time in milliseconds for this platform
 * @param {number} minBuildTime - Minimum timeout floor in milliseconds (safety net)
 * @returns {object} Comprehensive timing information for build orchestration
 * @returns {number} returns.elapsedTime - Time elapsed since job start (ms)
 * @returns {number} returns.remainingTime - Calculated remaining time (ms)
 * @returns {number} returns.timeoutSeconds - Timeout in seconds (for timeout command)
 * @returns {string} returns.elapsedHours - Formatted elapsed time (X.XX hours)
 * @returns {string} returns.remainingHours - Formatted remaining time (X.XX hours)
 * @returns {string} returns.timeoutMinutes - Timeout in minutes (for logging)
 */
function calculateBuildTimeout(jobStartTime, maxBuildTime, minBuildTime) {
    const elapsedTime = Date.now() - jobStartTime;
    let remainingTime = maxBuildTime - elapsedTime;
    
    // Apply minimum timeout
    remainingTime = Math.max(remainingTime, minBuildTime);
    
    const timeoutSeconds = Math.floor(remainingTime / 1000);
    
    return {
        elapsedTime,
        remainingTime,
        timeoutSeconds,
        elapsedHours: (elapsedTime / 3600000).toFixed(2),
        remainingHours: (remainingTime / 3600000).toFixed(2),
        timeoutMinutes: (timeoutSeconds / 60).toFixed(0)
    };
}

/**
 * Wait for process completion and synchronize filesystem writes
 *
 * This function ensures data integrity after intensive build operations by:
 * 1. Allowing running processes to complete gracefully
 * 2. Forcing filesystem synchronization to flush all pending writes
 * 3. Providing additional buffer time for filesystem operations to stabilize
 *
 * Critical for checkpoint creation and artifact uploads where data consistency
 * is essential. Chromium builds create hundreds of files simultaneously, and
 * this function prevents data corruption during state preservation.
 *
 * Used after:
 * - Build timeouts (to ensure state is saved)
 * - Checkpoint creation (to flush all writes before archiving)
 * - Major filesystem operations (to prevent race conditions)
 *
 * @param {number} waitTime - Wait time in milliseconds (default: 10000ms)
 * @returns {Promise<void>} Completes after synchronization
 */
async function waitAndSync(waitTime = 10000) {
    console.log(`Waiting ${waitTime / 1000} seconds for processes to finish...`);
    await new Promise(r => setTimeout(r, waitTime));
    
    console.log('Syncing filesystem...');
    await exec.exec('sync', [], {ignoreReturnCode: true});
    await new Promise(r => setTimeout(r, waitTime));
}

module.exports = {
    execWithTimeout,
    calculateBuildTimeout,
    waitAndSync
};

