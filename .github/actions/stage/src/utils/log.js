/**
 * Logging utilities
 */

/**
 * Filter out GitHub Actions artifact debug messages
 * This prevents verbose debug output from cluttering logs by intercepting process.stderr.
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
