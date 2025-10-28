/**
 * Artifact management utilities
 */

const {ARCHIVE} = require('../config/constants');

/**
 * Delete artifact with retries (ignore errors)
 * @param {object} artifact - Artifact client
 * @param {string} artifactName - Name of artifact to delete
 */
async function deleteArtifactSafely(artifact, artifactName) {
    try {
        await artifact.deleteArtifact(artifactName);
        console.log(`✓ Deleted artifact: ${artifactName}`);
    } catch (e) {
        // Artifact doesn't exist or deletion failed - that's fine
    }
}

/**
 * Clean up previous build artifacts (manifest + volumes)
 * @param {object} artifact - Artifact client
 * @param {string} baseArtifactName - Base name for artifacts
 */
async function cleanupPreviousArtifacts(artifact, baseArtifactName) {
    console.log('Cleaning up previous artifacts...');
    
    // Delete manifest
    await deleteArtifactSafely(artifact, `${baseArtifactName}-manifest`);
    
    // Try to delete volume artifacts
    for (let vol = 1; vol <= ARCHIVE.MAX_VOLUMES; vol++) {
        const volName = `${baseArtifactName}-vol${vol.toString().padStart(3, '0')}`;
        await deleteArtifactSafely(artifact, volName);
    }
}

/**
 * Upload artifact with retries
 * @param {object} artifact - Artifact client
 * @param {string} artifactName - Name for the artifact
 * @param {string[]} files - Files to upload
 * @param {string} rootDirectory - Root directory for files
 * @param {object} options - Upload options
 * @returns {Promise<boolean>} Success status
 */
async function uploadArtifactWithRetry(artifact, artifactName, files, rootDirectory, options = {}) {
    const maxRetries = 5;
    const retryDelay = 10000; // 10 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Try to delete existing artifact first
            if (attempt > 1) {
                await deleteArtifactSafely(artifact, artifactName);
            }
            
            await artifact.uploadArtifact(artifactName, files, rootDirectory, {
                retentionDays: options.retentionDays || ARCHIVE.RETENTION_DAYS,
                compressionLevel: options.compressionLevel || 0
            });
            
            console.log(`✓ Successfully uploaded ${artifactName}`);
            return true;
        } catch (e) {
            console.error(`Upload attempt ${attempt}/${maxRetries} failed: ${e.message}`);
            
            if (attempt < maxRetries) {
                console.log(`Retrying in ${retryDelay / 1000} seconds...`);
                await new Promise(r => setTimeout(r, retryDelay));
            }
        }
    }
    
    console.error(`✗ Failed to upload ${artifactName} after ${maxRetries} attempts`);
    return false;
}

/**
 * Filter out GitHub Actions debug messages
 * This prevents verbose debug output from cluttering logs
 */
function setupDebugFilter() {
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = function(chunk, encoding, callback) {
        const str = chunk.toString();
        if (str.includes('::debug::')) {
            if (callback) callback();
            return true;
        }
        return originalStderrWrite.apply(process.stderr, arguments);
    };
}

module.exports = {
    deleteArtifactSafely,
    cleanupPreviousArtifacts,
    uploadArtifactWithRetry,
    setupDebugFilter
};

