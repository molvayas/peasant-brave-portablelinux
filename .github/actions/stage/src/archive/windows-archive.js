/**
 * Windows-specific archive operations using 7z
 * 
 * Windows doesn't use multi-volume tar archives - instead it uses 7z compression
 * for checkpoint artifacts, which is simpler and works well with Windows filesystem.
 */

const exec = require('@actions/exec');
const io = require('@actions/io');
const path = require('path');
const {ARCHIVE} = require('../config/constants');

/**
 * Create 7z archive for Windows checkpoint
 * 
 * @param {string} workDir - Working directory containing files to archive
 * @param {string[]} paths - Paths to include in archive (relative to workDir)
 * @param {object} artifact - Artifact client for uploads
 * @param {string} artifactName - Name for artifact upload
 * @returns {Promise<void>}
 */
async function createWindowsCheckpoint(workDir, paths, artifact, artifactName) {
    console.log('=== Creating Windows Checkpoint (7z) ===');
    console.log(`Working directory: ${workDir}`);
    console.log(`Paths to archive: ${paths.join(', ')}`);
    
    const artifactPath = path.join(workDir, 'artifacts.7z');
    const password = process.env.ARCHIVE_PASSWORD;
    
    if (password) {
        console.log('🔒 Password protection: ENABLED');
    } else {
        console.log('⚠️  Password protection: DISABLED (no ARCHIVE_PASSWORD env var)');
    }
    
    console.log('Creating 7z archive...');
    console.log('This may take 30-50 minutes depending on build state size');
    
    // Start disk space monitor
    console.log('Starting disk space monitor (runs every 60 seconds)...');
    const monitorInterval = setInterval(() => {
        console.log(`\n[${new Date().toISOString()}] Disk Space Check:`);
        exec.exec('powershell', ['-Command', 'Get-Volume | Format-Table -AutoSize'], {
            ignoreReturnCode: true,
        });
    }, 60000);

    try {
        // Build list of paths to archive
        const fullPaths = paths.map(p => path.join(workDir, p));
        
        // Create 7z archive with fast compression (balanced speed/size)
        // -t7z = 7z format
        // -mx=3 = fast compression (level 3, balanced for large files)
        // -mtc=on = preserve timestamps
        // -mmt=3 = 3 threads
        // -m0=LZMA2:d256m:fb64 = LZMA2 with 256MB dictionary
        // -p = password (if set)
        // -mhe=on = encrypt headers (hide file names)
        const args = [
            'a', '-t7z',
            artifactPath,
            ...fullPaths,
            '-mx=3',
            '-mtc=on',
            '-mmt=3',
            '-m0=LZMA2:d256m:fb64'
        ];
        
        if (password) {
            args.push(`-p${password}`);
            args.push('-mhe=on');  // Encrypt headers to hide filenames
        }
        
        await exec.exec('7z', args, {ignoreReturnCode: true});
    } finally {
        // Stop disk space monitor
        clearInterval(monitorInterval);
        console.log('Stopped disk space monitor.');
    }
    
    console.log('✓ 7z archive created');
    
    // Upload artifact with retries
    console.log(`\nUploading checkpoint artifact: ${artifactName}...`);
    
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            // Try to delete existing artifact first
            if (attempt > 1) {
                try {
                    await artifact.deleteArtifact(artifactName);
                } catch (e) {
                    // Ignore deletion errors
                }
            }
            
            await artifact.uploadArtifact(
                artifactName,
                [artifactPath],
                workDir,
                {retentionDays: ARCHIVE.RETENTION_DAYS, compressionLevel: 0}
            );
            
            console.log('✓ Checkpoint artifact uploaded successfully');
            return;
        } catch (e) {
            console.error(`Upload attempt ${attempt}/5 failed: ${e.message}`);
            
            if (attempt < 5) {
                console.log('Retrying in 10 seconds...');
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    }
    
    throw new Error('Failed to upload checkpoint artifact after 5 attempts');
}

/**
 * Extract Windows checkpoint from 7z archive
 * 
 * @param {string} workDir - Working directory for extraction
 * @param {object} artifact - Artifact client for downloads
 * @param {string} artifactName - Name of artifact to download
 * @returns {Promise<void>}
 */
async function extractWindowsCheckpoint(workDir, artifact, artifactName) {
    console.log('=== Extracting Windows Checkpoint (7z) ===');
    console.log(`Working directory: ${workDir}`);
    console.log(`Artifact name: ${artifactName}`);
    
    const password = process.env.ARCHIVE_PASSWORD;
    
    if (password) {
        console.log('🔒 Password protection: ENABLED');
    } else {
        console.log('⚠️  Password protection: DISABLED (no ARCHIVE_PASSWORD env var)');
    }
    
    // Download artifact
    console.log('Downloading checkpoint artifact...');
    try {
        const artifactInfo = await artifact.getArtifact(artifactName);
        await artifact.downloadArtifact(artifactInfo.artifact.id, {path: workDir});
    } catch (e) {
        throw new Error(`Failed to download artifact: ${e.message}`);
    }
    
    // Extract with 7z
    const artifactPath = path.join(workDir, 'artifacts.7z');
    console.log(`Extracting ${artifactPath}...`);

    const args = [
        'x',
        artifactPath,
        `-o${workDir}`,
        '-y',               // Yes to all prompts
        '-mmt=3'            // Limit to 3 threads
    ];
    
    if (password) {
        args.push(`-p${password}`);
    }
    
    await exec.exec('7z', args, {ignoreReturnCode: true});
    
    console.log('✓ Checkpoint extracted');
    
    // Clean up archive file
    await io.rmRF(artifactPath);
    console.log('✓ Cleaned up archive file');
}

module.exports = {
    createWindowsCheckpoint,
    extractWindowsCheckpoint
};

