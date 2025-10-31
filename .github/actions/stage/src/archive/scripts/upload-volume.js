#!/usr/bin/env node
/**
 * Upload a volume artifact with retry logic
 * 
 * Usage: node upload-volume.js <filePath> <artifactName> <tempDir>
 * 
 * Arguments:
 *   filePath     - Path to file to upload
 *   artifactName - Name for the artifact
 *   tempDir      - Temporary directory (for node_modules path)
 */

const {DefaultArtifactClient} = require('@actions/artifact');

// Filter out debug messages from stdout/stderr unless debug mode is enabled
// Debug messages from @actions/core are written to stdout, not stderr
const isDebugMode = process.env['RUNNER_DEBUG'] === '1' || process.env['ACTIONS_STEP_DEBUG'] === 'true';

if (!isDebugMode) {
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    
    process.stdout.write = function(chunk, encoding, callback) {
        const str = chunk.toString();
        if (str.includes('::debug::')) {
            if (callback) callback();
            return true;
        }
        return originalStdoutWrite.apply(process.stdout, arguments);
    };
    
    process.stderr.write = function(chunk, encoding, callback) {
        const str = chunk.toString();
        if (str.includes('::debug::')) {
            if (callback) callback();
            return true;
        }
        return originalStderrWrite.apply(process.stderr, arguments);
    };
}

async function uploadVolume(filePath, artifactName, tempDir) {
    const artifact = new DefaultArtifactClient();
    
    console.log(`Uploading ${filePath} as ${artifactName}...`);
    
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await artifact.uploadArtifact(artifactName, [filePath], tempDir, {
                retentionDays: 1,
                compressionLevel: 0
            });
            console.log(`✓ Successfully uploaded ${artifactName}`);
            return 0;
        } catch (e) {
            console.error(`Attempt ${attempt + 1} failed: ${e.message}`);
            if (attempt < 4) {
                console.log('Retrying in 5 seconds...');
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
    
    console.error(`✗ Failed to upload after 5 attempts`);
    return 1;
}

const filePath = process.argv[2];
const artifactName = process.argv[3];
const tempDir = process.argv[4];

if (!filePath || !artifactName || !tempDir) {
    console.error('Usage: upload-volume.js <filePath> <artifactName> <tempDir>');
    process.exit(1);
}

uploadVolume(filePath, artifactName, tempDir)
    .then(code => process.exit(code))
    .catch(e => {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    });

