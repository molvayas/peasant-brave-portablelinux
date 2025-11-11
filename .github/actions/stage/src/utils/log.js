/**
 * Logging and output filtering utilities
 *
 * This module provides utilities for managing log output in GitHub Actions,
 * particularly for filtering out verbose debug messages from external tools
 * that would otherwise clutter the build logs.
 */

/**
 * Setup stderr filtering to suppress GitHub Actions artifact debug messages
 *
 * I don't remember why it's here.
 */
function setupArtifactDebugFilter() {
    const originalStderrWrite = process.stderr.write;

    process.stderr.write = function(chunk, encoding, callback) {
        const str = chunk.toString();
        // This targets the verbose messages from @actions/artifact http client
        if (str.includes('::debug::') || str.includes('HTTP/2|204|') || str.includes('HTTP/2|201|') || str.includes('upload chunk')) {
            if (callback) callback();
            return true;
        }
        return originalStderrWrite.apply(process.stderr, arguments);
    };
}

module.exports = {
    setupArtifactDebugFilter
};
