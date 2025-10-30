/**
 * Execution utilities with timeout support
 */

const exec = require('@actions/exec');

/**
 * Run a command with timeout using platform-specific timeout command
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {object} options - Options including cwd, timeoutSeconds, and useGTimeout
 * @returns {Promise<number>} Exit code (124 if timeout, per timeout command convention)
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
        console.log(`⏱️ Timeout reached after ${(timeoutSeconds / 60).toFixed(0)} minutes`);
    }
    
    return exitCode;
}

/**
 * Calculate remaining time for build with safety margins
 * @param {number} jobStartTime - Job start timestamp
 * @param {number} maxBuildTime - Maximum build time in milliseconds
 * @param {number} minBuildTime - Minimum build time in milliseconds
 * @returns {object} Timing information
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
 * Wait for processes to finish and sync filesystem
 * @param {number} waitTime - Time to wait in milliseconds
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

