/**
 * Multi-volume archive creation and extraction
 * 
 * This module handles creating and extracting large archives that are split into
 * multiple volumes to work within disk space and upload constraints.
 * 
 * Uses dedicated bash/node scripts for volume processing instead of generating them dynamically.
 */

const io = require('@actions/io');
const exec = require('@actions/exec');
const fs = require('fs').promises;
const path = require('path');
const {ARCHIVE} = require('../config/constants');

// Path to scripts directory
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

/**
 * Create multi-volume tar archive with streaming compression and upload
 * 
 * @param {string} archiveBaseName - Base name for archive (without extension)
 * @param {string} workDir - Working directory containing files to archive
 * @param {string[]} paths - Paths to include in archive (relative to workDir)
 * @param {object} artifact - Artifact client for uploads
 * @param {string} artifactName - Name for artifact uploads
 * @param {object} options - Options including tarCommand (default: 'tar')
 * @returns {Promise<number>} Number of volumes created
 */
async function createMultiVolumeArchive(archiveBaseName, workDir, paths, artifact, artifactName, options = {}) {
    const tarCommand = options.tarCommand || 'tar';
    console.log('=== Creating Multi-Volume Archive ===');
    console.log(`Base name: ${archiveBaseName}`);
    console.log(`Working directory: ${workDir}`);
    console.log(`Paths to archive: ${paths.join(', ')}`);
    
    const tempDir = path.join(workDir, 'tar-temp');
    await io.mkdirP(tempDir);
    
    const tarArchivePath = path.join(tempDir, `${archiveBaseName}.tar`);
    const processedVolumesFile = path.join(tempDir, 'processed-volumes.txt');
    
    // Verify dependencies
    await _verifyDependencies();
    
    console.log('\nStarting multi-volume tar creation...');
    console.log(`Archive base: ${tarArchivePath}`);
    console.log(`Temp directory: ${tempDir}`);
    console.log('Files will be removed as they are archived to save disk space\n');
    
    // Setup volume processing
    await _setupVolumeProcessing(tempDir, artifactName, processedVolumesFile);
    
    // Create wrapper script that calls the actual script with arguments
    const volumeScriptPath = path.join(tempDir, 'next-volume-wrapper.sh');
    await _createWrapperScript(
        volumeScriptPath,
        tempDir,
        artifactName,
        processedVolumesFile,
        ARCHIVE.COMPRESSION_LEVEL
    );
    
    // Start tar process with multi-volume flags
    console.log(`[Tar] Starting tar command (using ${tarCommand})...`);
    const tarExitCode = await exec.exec(tarCommand, [
        '-cM',  // Create multi-volume archive
        '-L', ARCHIVE.VOLUME_SIZE,  // Volume size (e.g., '5G')
        '-F', volumeScriptPath,  // Script for new volumes
        '-f', tarArchivePath,
        '-H', 'posix',
        '--atime-preserve',
        '--remove-files',  // Delete files after adding to archive
        '-C', workDir,
        ...paths
    ], {
        ignoreReturnCode: true
    });
    
    console.log(`\n[Main] Tar process completed with exit code: ${tarExitCode}`);
    
    // Process the final volume (tar only calls the script BETWEEN volumes)
    const volumeCount = await _processFinalVolume(
        tempDir,
        tarArchivePath,
        processedVolumesFile,
        artifactName
    );
    
    // Create and upload manifest
    await _createAndUploadManifest(
        tempDir,
        archiveBaseName,
        volumeCount,
        artifactName
    );
    
    // Cleanup temp directory
    await io.rmRF(tempDir);
    
    console.log('\n✓ Multi-volume archive creation complete');
    return volumeCount;
}

/**
 * Extract multi-volume tar archive with streaming download and decompression
 * 
 * @param {string} workDir - Working directory for extraction
 * @param {object} artifact - Artifact client for downloads
 * @param {string} artifactName - Base name for artifacts
 * @param {object} options - Options including tarCommand (default: 'tar')
 */
async function extractMultiVolumeArchive(workDir, artifact, artifactName, options = {}) {
    const tarCommand = options.tarCommand || 'tar';
    console.log('=== Extracting Multi-Volume Archive ===');
    
    const tempDir = path.join(workDir, 'extract-temp');
    await io.mkdirP(tempDir);
    
    // Download and parse manifest
    const manifest = await _downloadManifest(tempDir, artifact, artifactName);
    
    console.log(`\nManifest loaded:`);
    console.log(`  Base name: ${manifest.baseName}`);
    console.log(`  Total volumes: ${manifest.volumeCount}`);
    console.log(`  Created: ${manifest.timestamp}`);
    
    // Create extraction infrastructure
    const volumesDir = path.join(tempDir, 'volumes');
    await io.mkdirP(volumesDir);
    
    await _setupExtraction(tempDir, volumesDir, manifest, artifactName);
    
    // Download first volume before starting extraction
    const firstVolumePath = await _downloadFirstVolume(
        tempDir,
        volumesDir,
        manifest,
        artifact
    );
    
    // Create wrapper script for extraction
    const extractScriptPath = path.join(tempDir, 'next-volume-extract-wrapper.sh');
    await _createExtractionWrapperScript(
        extractScriptPath,
        manifest.baseName,
        volumesDir,
        manifest.volumeCount,
        artifactName,
        tempDir
    );
    
    // Extract using multi-volume mode
    console.log('\n=== Extracting Multi-Volume Archive ===');
    console.log(`Using ${tarCommand} to download subsequent volumes on-demand via the info script...`);
    
    await exec.exec(tarCommand, ['-xM', '-f', firstVolumePath, '-F', extractScriptPath, '-C', workDir]);
    
    console.log('✓ Extraction complete');
    
    // Cleanup
    await io.rmRF(tempDir);
    console.log('✓ Cleaned up temporary files');
    console.log('\n✓ Multi-volume extraction complete');
}

// ============================================================================
// Private helper functions
// ============================================================================

/**
 * Verify required dependencies are installed
 */
async function _verifyDependencies() {
    console.log('Verifying dependencies...');
    
    // Check zstd
    try {
        await exec.exec('zstd', ['--version'], {ignoreReturnCode: false});
        console.log('✓ zstd is available');
    } catch (e) {
        throw new Error('zstd is not installed! Please install zstd before running.');
    }
}

/**
 * Setup volume processing (install npm deps)
 */
async function _setupVolumeProcessing(tempDir, artifactName, processedVolumesFile) {
    // Install @actions/artifact in temp directory for the upload script
    console.log('Installing @actions/artifact in temp directory...');
    await exec.exec('npm', ['install', '@actions/artifact@2.2.1'], {
        cwd: tempDir,
        ignoreReturnCode: true
    });
    console.log('✓ Dependencies installed');
}

/**
 * Create wrapper script that calls the actual script with arguments
 */
async function _createWrapperScript(wrapperPath, tempDir, artifactName, processedVolumesFile, compressionLevel) {
    const actualScriptPath = path.join(SCRIPTS_DIR, 'next-volume.sh');
    
    const wrapper = `#!/bin/bash
# Wrapper script that calls the actual volume processing script with arguments
exec "${actualScriptPath}" "${tempDir}" "${artifactName}" "${processedVolumesFile}" "${compressionLevel}" "${SCRIPTS_DIR}"
`;
    
    await fs.writeFile(wrapperPath, wrapper);
    await exec.exec('chmod', ['+x', wrapperPath]);
}

/**
 * Process the final volume after tar completes
 */
async function _processFinalVolume(tempDir, tarArchivePath, processedVolumesFile, artifactName) {
    console.log('\n[Main] Checking for unprocessed final volume...');
    
    // Read the list of processed volumes
    let volumeCount = 0;
    try {
        const processedContent = await fs.readFile(processedVolumesFile, 'utf-8');
        const processedLines = processedContent.trim().split('\n').filter(l => l);
        volumeCount = processedLines.length;
        
        console.log(`[Main] Already processed ${volumeCount} volume(s) during tar execution`);
        processedLines.forEach((line, idx) => {
            console.log(`  - Volume ${idx + 1}: ${path.basename(line)}`);
        });
    } catch (e) {
        console.log(`[Main] No processed volumes file found (single-volume archive)`);
    }
    
    // Check for the final unprocessed volume
    let finalVolumePath;
    if (volumeCount === 0) {
        finalVolumePath = tarArchivePath;
    } else {
        finalVolumePath = `${tarArchivePath}-${volumeCount + 1}`;
    }
    
    console.log(`[Main] Looking for final volume at: ${finalVolumePath}`);
    
    try {
        const stats = await fs.stat(finalVolumePath);
        const sizeGB = (stats.size / (1024 * 1024 * 1024)).toFixed(2);
        console.log(`[Main] ✓ Found unprocessed final volume (${sizeGB} GB)`);
        console.log(`[Main] Processing final volume ${volumeCount + 1}...`);
        
        // Compress with zstd
        const compressedPath = `${finalVolumePath}.zst`;
        console.log(`[Main] Compressing with zstd...`);
        await exec.exec('zstd', [`-${ARCHIVE.COMPRESSION_LEVEL}`, '-T0', '--rm', finalVolumePath, '-o', compressedPath]);
        
        const compressedStats = await fs.stat(compressedPath);
        const compressedSizeGB = (compressedStats.size / (1024 * 1024 * 1024)).toFixed(2);
        console.log(`[Main] Compressed to ${compressedSizeGB} GB`);
        
        // Upload
        const finalVolumeNum = volumeCount + 1;
        const volNumFormatted = finalVolumeNum.toString().padStart(3, '0');
        const finalArtifactName = `${artifactName}-vol${volNumFormatted}`;
        
        console.log(`[Main] Uploading as ${finalArtifactName}...`);
        
        const uploadScriptPath = path.join(SCRIPTS_DIR, 'upload-volume.js');
        const uploadExitCode = await exec.exec('node', [
            uploadScriptPath,
            compressedPath,
            finalArtifactName,
            tempDir
        ], {
            ignoreReturnCode: true,
            env: {
                ...process.env,
                NODE_PATH: path.join(tempDir, 'node_modules')
            }
        });
        
        if (uploadExitCode === 0) {
            console.log(`[Main] ✓ Successfully uploaded final volume`);
            await fs.unlink(compressedPath);
            volumeCount++;
        } else {
            throw new Error(`Upload failed with exit code ${uploadExitCode}`);
        }
        
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log(`[Main] No final volume found - all volumes processed during tar`);
        } else {
            console.error(`[Main] Error processing final volume: ${e.message}`);
            throw e;
        }
    }
    
    return volumeCount;
}

/**
 * Create and upload archive manifest
 */
async function _createAndUploadManifest(tempDir, archiveBaseName, volumeCount, artifactName) {
    console.log(`\n[Main] Total volumes created and uploaded: ${volumeCount}`);
    
    const uploadedVolumes = [];
    for (let i = 1; i <= volumeCount; i++) {
        uploadedVolumes.push(`${artifactName}-vol${i.toString().padStart(3, '0')}`);
    }
    
    const manifest = {
        baseName: archiveBaseName,
        volumeCount: volumeCount,
        volumes: uploadedVolumes,
        timestamp: new Date().toISOString()
    };
    
    const manifestPath = path.join(tempDir, 'archive-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    
    console.log('\n=== Uploading manifest ===');
    
    const {DefaultArtifactClient} = require('@actions/artifact');
    const artifact = new DefaultArtifactClient();
    
    await artifact.uploadArtifact(`${artifactName}-manifest`, [manifestPath], tempDir, {
        retentionDays: ARCHIVE.RETENTION_DAYS,
        compressionLevel: 0
    });
    console.log('✓ Manifest uploaded');
}

/**
 * Download and parse manifest
 */
async function _downloadManifest(tempDir, artifact, artifactName) {
    console.log('Downloading manifest...');
    const manifestArtifactName = `${artifactName}-manifest`;
    
    try {
        const manifestInfo = await artifact.getArtifact(manifestArtifactName);
        await artifact.downloadArtifact(manifestInfo.artifact.id, {path: tempDir});
    } catch (e) {
        throw new Error(`Failed to download manifest: ${e.message}`);
    }
    
    const manifestPath = path.join(tempDir, 'archive-manifest.json');
    return JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
}

/**
 * Setup extraction (install npm deps, save env vars)
 */
async function _setupExtraction(tempDir, volumesDir, manifest, artifactName) {
    // Install dependencies
    console.log('Installing dependencies for download helper...');
    await exec.exec('npm', ['install', '@actions/artifact@2.2.1', '@actions/exec@1.1.1'], {
        cwd: tempDir,
        ignoreReturnCode: true
    });
    
    // Save environment variables for scripts
    const actionsEnv = {
        ACTIONS_RUNTIME_TOKEN: process.env.ACTIONS_RUNTIME_TOKEN || '',
        ACTIONS_RUNTIME_URL: process.env.ACTIONS_RUNTIME_URL || '',
        ACTIONS_RESULTS_URL: process.env.ACTIONS_RESULTS_URL || '',
        GITHUB_RUN_ID: process.env.GITHUB_RUN_ID || '',
        GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT || ''
    };
    
    const envFilePath = path.join(tempDir, 'actions-env.sh');
    const envFileContent = Object.entries(actionsEnv)
        .map(([key, value]) => `export ${key}="${value}"`)
        .join('\n');
    await fs.writeFile(envFilePath, envFileContent);
}

/**
 * Create extraction wrapper script
 */
async function _createExtractionWrapperScript(wrapperPath, baseName, volumesDir, volumeCount, artifactBase, tempDir) {
    const actualScriptPath = path.join(SCRIPTS_DIR, 'next-volume-extract.sh');
    const envFilePath = path.join(tempDir, 'actions-env.sh');
    
    const wrapper = `#!/bin/bash
# Source environment variables
if [ -f "${envFilePath}" ]; then
    source "${envFilePath}"
fi

# Call actual script with arguments
exec "${actualScriptPath}" "${baseName}" "${volumesDir}" "${volumeCount}" "${artifactBase}" "${tempDir}" "${SCRIPTS_DIR}"
`;
    
    await fs.writeFile(wrapperPath, wrapper);
    await exec.exec('chmod', ['+x', wrapperPath]);
}

/**
 * Download first volume
 */
async function _downloadFirstVolume(tempDir, volumesDir, manifest, artifact) {
    console.log('\n=== Downloading First Volume ===');
    const firstVolumePath = path.join(volumesDir, `${manifest.baseName}.tar`);
    const firstArtifactName = manifest.volumes[0];
    
    console.log(`Fetching ${firstArtifactName}...`);
    const firstDownloadPath = path.join(tempDir, 'dl-1');
    await io.mkdirP(firstDownloadPath);
    
    const volumeInfo = await artifact.getArtifact(firstArtifactName);
    await artifact.downloadArtifact(volumeInfo.artifact.id, {path: firstDownloadPath});
    
    const firstFiles = await fs.readdir(firstDownloadPath);
    const firstCompressed = firstFiles.find(f => f.endsWith('.zst'));
    const firstCompressedPath = path.join(firstDownloadPath, firstCompressed);
    
    console.log('Decompressing first volume...');
    await exec.exec('zstd', ['-d', '--rm', firstCompressedPath, '-o', firstVolumePath]);
    await io.rmRF(firstDownloadPath);
    console.log('✓ First volume ready');
    
    return firstVolumePath;
}

module.exports = {
    createMultiVolumeArchive,
    extractMultiVolumeArchive
};
