const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const {DefaultArtifactClient} = require('@actions/artifact');
const glob = require('@actions/glob');
const fs = require('fs').promises;
const path = require('path');

/**
 * Run a command with timeout using Linux native timeout command
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {object} options - Options including cwd and timeoutSeconds
 * @returns {Promise<number>} Exit code (124 if timeout, per timeout command convention)
 */
async function execWithTimeout(command, args, options = {}) {
    const {cwd, timeoutSeconds} = options;
    
    console.log(`Running: ${command} ${args.join(' ')}`);
    console.log(`Timeout: ${(timeoutSeconds / 60).toFixed(0)} minutes (${(timeoutSeconds / 3600).toFixed(2)} hours)`);
    
    // Use Linux native timeout command
    // -k 5m: Send SIGKILL if process doesn't die within 5 minutes after initial signal
    // -s INT: Send SIGINT (graceful, like Ctrl+C) as initial signal
    // Exit code 124: timeout occurred
    const timeoutArgs = [
        '-k', '5m',           // Kill after 5 min if not responding
        '-s', 'INT',          // Send SIGINT first (graceful)
        `${timeoutSeconds}s`, // Timeout in seconds
        command,
        ...args
    ];
    
    const exitCode = await exec.exec('timeout', timeoutArgs, {
        cwd: cwd,
        ignoreReturnCode: true
    });
    
    if (exitCode === 124) {
        console.log(`⏱️ Timeout reached after ${(timeoutSeconds / 60).toFixed(0)} minutes`);
    }
    
    return exitCode;
}

/**
 * Run ncdu to analyze disk usage and export to JSON
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
 * Create multi-volume tar archive with streaming compression and upload
 * This approach minimizes disk usage by:
 * 1. Creating tar volumes with --remove-files (deletes source files)
 * 2. Compressing each volume immediately after creation
 * 3. Uploading compressed volume
 * 4. Deleting both uncompressed and compressed volumes
 * 
 * @param {string} archiveBaseName - Base name for archive (without extension)
 * @param {string} workDir - Working directory containing files to archive
 * @param {string[]} paths - Paths to include in archive (relative to workDir)
 * @param {object} artifact - Artifact client for uploads
 * @param {string} artifactName - Name for artifact uploads
 * @returns {Promise<number>} Number of volumes created
 */
async function createMultiVolumeArchive(archiveBaseName, workDir, paths, artifact, artifactName) {
    console.log('=== Creating Multi-Volume Archive ===');
    console.log(`Base name: ${archiveBaseName}`);
    console.log(`Working directory: ${workDir}`);
    console.log(`Paths to archive: ${paths.join(', ')}`);
    
    // Use 5GB volumes (in 512-byte blocks: 5*1024*1024*1024/512 = 10485760)
    const volumeSizeBlocks = '10485760';
    const tempDir = path.join(workDir, 'tar-temp');
    await io.mkdirP(tempDir);
    
    const tarArchivePath = path.join(tempDir, `${archiveBaseName}.tar`);
    
    // Verify zstd is available
    console.log('Verifying zstd is installed...');
    try {
        await exec.exec('zstd', ['--version']);
        console.log('✓ zstd is available');
    } catch (e) {
        throw new Error('zstd is not installed! Please install zstd before running this script.');
    }
    
    console.log('\nStarting multi-volume tar creation...');
    console.log(`Volume size: 5GB (${volumeSizeBlocks} blocks of 512 bytes)`);
    console.log(`Archive base: ${tarArchivePath}`);
    console.log(`Temp directory: ${tempDir}`);
    console.log('Files will be removed as they are archived to save disk space\n');
    
    // Create tar with multi-volume support
    // The info script is called at the end of each tape/volume
    // It should compress, upload, cleanup, then return the next volume name
    // This makes the process synchronous and reliable
    const volumeScriptPath = path.join(tempDir, 'next-volume.sh');
    const processedVolumesFile = path.join(tempDir, 'processed-volumes.txt');
    const volumeScript = `#!/bin/bash
# This script is called by tar at the end of each volume
# Environment variables provided by tar:
#   TAR_ARCHIVE - current archive name
#   TAR_VOLUME - current volume number (1-based)
#   TAR_FD - file descriptor to send new volume name

set -e

echo "" >&2
echo "[Volume Script] ============================================" >&2
echo "[Volume Script] Called at: \$(date)" >&2
echo "[Volume Script] TAR_VOLUME: \${TAR_VOLUME:-initial}" >&2
echo "[Volume Script] TAR_ARCHIVE: \$TAR_ARCHIVE" >&2
echo "[Volume Script] TAR_FD: \$TAR_FD" >&2
echo "[Volume Script] ============================================" >&2

# Determine which volume to process and what to return
# Note: tar uses the base name for the first volume, then adds suffixes
# Volume 1: build-state.tar (base name)
# Volume 2: build-state.tar-2
# Volume 3: build-state.tar-3
# etc.

# IMPORTANT: TAR_ARCHIVE changes with each call!
# On first call: TAR_ARCHIVE = "build-state.tar"
# On second call: TAR_ARCHIVE = "build-state.tar-2" (the name we returned!)
# So we need to extract the base name by stripping any -N suffix
BASE_ARCHIVE=\$(echo "\$TAR_ARCHIVE" | sed 's/-[0-9]*$//')
echo "[Volume Script] Base archive name: \$BASE_ARCHIVE" >&2

if [ -z "\$TAR_VOLUME" ]; then
    # First call - tar hasn't started yet
    # Return base name (tar will use this as-is for volume 1)
    NEXT_ARCHIVE="\${BASE_ARCHIVE}"
    echo "[Volume Script] First call - volume 1 will use base name: \$NEXT_ARCHIVE" >&2
else
    # TAR_VOLUME=N means tar is about to start volume N
    # So we need to process volume N-1 (the one that just completed)
    COMPLETED_VOLUME_NUM=\$((TAR_VOLUME - 1))
    
    # Volume naming: first volume uses base name, subsequent volumes get suffixes
    if [ \$COMPLETED_VOLUME_NUM -eq 1 ]; then
        # Volume 1 uses the base name (no suffix)
        COMPLETED_VOLUME="\${BASE_ARCHIVE}"
    else
        # Volume 2+ use BASE_ARCHIVE-N format (always use BASE, not TAR_ARCHIVE!)
        COMPLETED_VOLUME="\${BASE_ARCHIVE}-\${COMPLETED_VOLUME_NUM}"
    fi
    
    echo "[Volume Script] Processing completed volume \${COMPLETED_VOLUME_NUM}: \${COMPLETED_VOLUME}" >&2
    
    if [ ! -f "\$COMPLETED_VOLUME" ]; then
        echo "[Volume Script] ERROR: Completed volume file not found!" >&2
        echo "[Volume Script] Looking for: \$COMPLETED_VOLUME" >&2
        echo "[Volume Script] Files in directory:" >&2
        ls -lh "\$(dirname "\$COMPLETED_VOLUME")" >&2 || true
        exit 1
    fi
    
    # Get file size for logging
    SIZE=\$(du -h "\$COMPLETED_VOLUME" | cut -f1)
    echo "[Volume Script] Volume size: \$SIZE" >&2
    
    # Compress with zstd
    echo "[Volume Script] Compressing with zstd..." >&2
    COMPRESSED="\${COMPLETED_VOLUME}.zst"
    zstd -3 -T0 --rm "\$COMPLETED_VOLUME" -o "\$COMPRESSED" 2>&1 | sed 's/^/[zstd] /' >&2
    
    COMPRESSED_SIZE=\$(du -h "\$COMPRESSED" | cut -f1)
    echo "[Volume Script] Compressed to: \$COMPRESSED_SIZE" >&2
    
    # Upload using Node.js script
    echo "[Volume Script] Uploading volume \${COMPLETED_VOLUME_NUM}..." >&2
    VOLUME_NUM=\$(printf "%03d" \$COMPLETED_VOLUME_NUM)
    
    # Run upload and capture exit code properly
    set +e  # Temporarily disable exit on error to capture exit code
    node "${tempDir}/upload-volume.js" "\$COMPRESSED" "${artifactName}-vol\${VOLUME_NUM}" 2>&1 | sed 's/^/[upload] /' >&2
    UPLOAD_EXIT=\${PIPESTATUS[0]}  # Get exit code of node, not sed
    set -e  # Re-enable exit on error
    
    if [ \$UPLOAD_EXIT -ne 0 ]; then
        echo "[Volume Script] ERROR: Upload failed with exit code \$UPLOAD_EXIT" >&2
        exit 1
    fi
    
    echo "[Volume Script] Upload successful, cleaning up..." >&2
    rm -f "\$COMPRESSED"
    echo "[Volume Script] Volume \${COMPLETED_VOLUME_NUM} processed successfully" >&2
    
    # Track processed volume
    echo "\${COMPLETED_VOLUME}" >> "${processedVolumesFile}"
    
    # Generate next volume name (always use BASE_ARCHIVE!)
    # tar will create volume TAR_VOLUME with suffix
    NEXT_ARCHIVE="\${BASE_ARCHIVE}-\${TAR_VOLUME}"
    echo "[Volume Script] Next volume (volume \${TAR_VOLUME}) will be: \$NEXT_ARCHIVE" >&2
fi

# Send new volume name to tar via TAR_FD
echo "\$NEXT_ARCHIVE" >&"\$TAR_FD"
echo "[Volume Script] Continuing to next volume..." >&2
echo "[Volume Script] ============================================" >&2
echo "" >&2

exit 0
`;
    
    await fs.writeFile(volumeScriptPath, volumeScript);
    await exec.exec('chmod', ['+x', volumeScriptPath]);
    
    // Install @actions/artifact in temp directory for the upload script
    console.log('Installing @actions/artifact in temp directory...');
    await exec.exec('npm', ['install', '@actions/artifact@2.2.1'], {
        cwd: tempDir,
        ignoreReturnCode: true
    });
    
    // Create Node.js upload helper script
    const uploadScriptPath = path.join(tempDir, 'upload-volume.js');
    const uploadScript = `const {DefaultArtifactClient} = require('@actions/artifact');

async function uploadVolume(filePath, artifactName) {
    const artifact = new DefaultArtifactClient();
    const tempDir = '${tempDir}';
    
    console.log(\`Uploading \${filePath} as \${artifactName}...\`);
    
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await artifact.uploadArtifact(artifactName, [filePath], tempDir, {
                retentionDays: 1,
                compressionLevel: 0
            });
            console.log(\`✓ Successfully uploaded \${artifactName}\`);
            return 0;
        } catch (e) {
            console.error(\`Attempt \${attempt + 1} failed: \${e.message}\`);
            if (attempt < 4) {
                console.log('Retrying in 5 seconds...');
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
    
    console.error(\`✗ Failed to upload after 5 attempts\`);
    return 1;
}

const filePath = process.argv[2];
const artifactName = process.argv[3];

uploadVolume(filePath, artifactName).then(code => process.exit(code)).catch(e => {
    console.error(\`Error: \${e.message}\`);
    process.exit(1);
});
`;
    
    await fs.writeFile(uploadScriptPath, uploadScript);
    console.log('✓ Created volume processing script');
    console.log('✓ Created upload helper script');
    
    // Start tar process with multi-volume flags
    let tarExitCode = 0;
    console.log('[Tar] Starting tar command with args:', [
        '-cM',  // Create multi-volume archive
        '-L', volumeSizeBlocks,  // Volume size in blocks
        '-F', volumeScriptPath,  // Script for new volumes
        '-f', tarArchivePath,
        '-H', 'posix',
        '--atime-preserve',
        '--remove-files',  // Delete files after adding to archive
        '-C', workDir,
        ...paths
    ].join(' '));
    
    const tarProcess = exec.exec('tar', [
        '-cM',  // Create multi-volume archive
        '-L', volumeSizeBlocks,  // Volume size in blocks
        '-F', volumeScriptPath,  // Script for new volumes
        '-f', tarArchivePath,
        '-H', 'posix',
        '--atime-preserve',
        '--remove-files',  // Delete files after adding to archive
        '-C', workDir,
        ...paths
    ], {
        ignoreReturnCode: true
    }).then(code => {
        console.log(`[Tar] Process exited with code: ${code}`);
        tarExitCode = code;
    });
    
    // No monitoring needed - the info script handles everything synchronously!
    // Just wait for tar to complete
    console.log('\n[Main] Tar is running...');
    console.log('[Main] The info script will handle compression and upload for each volume');
    console.log('[Main] Waiting for tar to complete...\n');
    
    await tarProcess;
    
    console.log(`\n[Main] Tar process completed with exit code: ${tarExitCode}`);
    
    // Read the list of processed volumes from the tracking file
    const uploadedVolumes = [];
    let volumeCount = 0;
    
    try {
        const processedContent = await fs.readFile(processedVolumesFile, 'utf-8');
        const processedLines = processedContent.trim().split('\n').filter(l => l);
        volumeCount = processedLines.length;
        
        console.log(`[Main] Processed ${volumeCount} volume(s):`);
        processedLines.forEach((line, idx) => {
            const volNum = (idx + 1).toString().padStart(3, '0');
            uploadedVolumes.push(`${artifactName}-vol${volNum}`);
            console.log(`  - Volume ${idx + 1}: ${path.basename(line)}`);
        });
    } catch (e) {
        console.log(`[Main] Warning: Could not read processed volumes file: ${e.message}`);
    }
    
    console.log(`\n[Main] Total volumes created and uploaded: ${volumeCount}`);
    
    // Create and upload manifest
    const manifest = {
        baseName: archiveBaseName,
        volumeCount: volumeCount,
        volumes: uploadedVolumes,
        timestamp: new Date().toISOString(),
        volumeSize: '5GB'
    };
    
    const manifestPath = path.join(tempDir, 'archive-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    
    console.log('\n=== Uploading manifest ===');
    await artifact.uploadArtifact(`${artifactName}-manifest`, [manifestPath], tempDir, {
        retentionDays: 1,
        compressionLevel: 0
    });
    console.log('✓ Manifest uploaded');
    
    // Cleanup temp directory
    await io.rmRF(tempDir);
    
    console.log('\n✓ Multi-volume archive creation complete');
    return volumeCount;
}

/**
 * Extract multi-volume tar archive with streaming download and decompression
 * Uses tar -xM (multi-volume mode) with an info script to provide volume names
 * 
 * @param {string} workDir - Working directory for extraction
 * @param {object} artifact - Artifact client for downloads
 * @param {string} artifactName - Base name for artifacts
 */
async function extractMultiVolumeArchive(workDir, artifact, artifactName) {
    console.log('=== Extracting Multi-Volume Archive ===');
    
    const tempDir = path.join(workDir, 'extract-temp');
    await io.mkdirP(tempDir);
    
    // Download manifest first
    console.log('Downloading manifest...');
    const manifestArtifactName = `${artifactName}-manifest`;
    try {
        const manifestInfo = await artifact.getArtifact(manifestArtifactName);
        await artifact.downloadArtifact(manifestInfo.artifact.id, {path: tempDir});
    } catch (e) {
        throw new Error(`Failed to download manifest: ${e.message}`);
    }
    
    const manifestPath = path.join(tempDir, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    
    console.log(`\nManifest loaded:`);
    console.log(`  Base name: ${manifest.baseName}`);
    console.log(`  Total volumes: ${manifest.volumeCount}`);
    console.log(`  Volume size: ${manifest.volumeSize}`);
    console.log(`  Created: ${manifest.timestamp}`);
    
    // Create a Node.js helper script for downloading/decompressing volumes on demand
    const volumesDir = path.join(tempDir, 'volumes');
    await io.mkdirP(volumesDir);
    
    const downloadHelperPath = path.join(tempDir, 'download-volume.js');
    const downloadHelper = `const {DefaultArtifactClient} = require('@actions/artifact');
const {exec} = require('@actions/exec');
const fs = require('fs').promises;
const path = require('path');

async function downloadAndDecompress(volumeNum, artifactName, outputPath) {
    const artifact = new DefaultArtifactClient();
    const tempDownload = path.join('${tempDir}', \`dl-\${volumeNum}\`);
    
    try {
        await fs.mkdir(tempDownload, {recursive: true});
        
        console.error(\`[Download] Fetching \${artifactName}...\`);
        const volumeInfo = await artifact.getArtifact(artifactName);
        await artifact.downloadArtifact(volumeInfo.artifact.id, {path: tempDownload});
        
        // Find compressed file
        const files = await fs.readdir(tempDownload);
        const compressedFile = files.find(f => f.endsWith('.zst'));
        if (!compressedFile) throw new Error('No .zst file found');
        
        const compressedPath = path.join(tempDownload, compressedFile);
        
        console.error(\`[Download] Decompressing to \${path.basename(outputPath)}...\`);
        await exec('zstd', ['-d', '--rm', compressedPath, '-o', outputPath]);
        
        console.error(\`[Download] ✓ Volume \${volumeNum} ready\`);
        
        // Cleanup download dir
        await fs.rm(tempDownload, {recursive: true, force: true});
        
        return 0;
    } catch (e) {
        console.error(\`[Download] Error: \${e.message}\`);
        return 1;
    }
}

const volumeNum = parseInt(process.argv[2]);
const artifactName = process.argv[3];
const outputPath = process.argv[4];

downloadAndDecompress(volumeNum, artifactName, outputPath)
    .then(code => process.exit(code))
    .catch(e => {
        console.error(e);
        process.exit(1);
    });
`;
    
    await fs.writeFile(downloadHelperPath, downloadHelper);
    
    // Install dependencies for the download helper
    console.log('Installing dependencies for download helper...');
    await exec.exec('npm', ['install', '@actions/artifact@2.2.1', '@actions/exec@1.1.1'], {
        cwd: tempDir,
        ignoreReturnCode: true
    });
    
    // Capture environment variables needed by @actions/artifact
    const actionsEnv = {
        ACTIONS_RUNTIME_TOKEN: process.env.ACTIONS_RUNTIME_TOKEN || '',
        ACTIONS_RUNTIME_URL: process.env.ACTIONS_RUNTIME_URL || '',
        ACTIONS_RESULTS_URL: process.env.ACTIONS_RESULTS_URL || '',
        GITHUB_RUN_ID: process.env.GITHUB_RUN_ID || '',
        GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT || ''
    };
    
    // Write environment to a file that the script can source
    const envFilePath = path.join(tempDir, 'actions-env.sh');
    const envFileContent = Object.entries(actionsEnv)
        .map(([key, value]) => `export ${key}="${value}"`)
        .join('\n');
    await fs.writeFile(envFilePath, envFileContent);
    
    // Create extraction script that downloads volumes on-demand and cleans up
    const extractScriptPath = path.join(tempDir, 'next-volume-extract.sh');
    const extractScript = `#!/bin/bash
set -e

// # Source the environment variables needed for GitHub Actions artifact API
################################################################ source "${envFilePath}"

BASE_NAME="${manifest.baseName}"
VOLUMES_DIR="${volumesDir}"
MANIFEST_FILE="${manifestPath}"
TEMP_DIR="${tempDir}"

# Parse manifest to get artifact names
VOLUME_COUNT=${manifest.volumeCount}
ARTIFACT_BASE="${artifactName}"

# Track previous volume for deletion
PREV_VOLUME_FILE=""

if [ -z "\$TAR_VOLUME" ]; then
    # First call - prepare volume 1
    VOLUME_NUM=1
    VOLUME_FILE="\${VOLUMES_DIR}/\${BASE_NAME}.tar"
else
    VOLUME_NUM=\$TAR_VOLUME
    VOLUME_FILE="\${VOLUMES_DIR}/\${BASE_NAME}.tar-\${VOLUME_NUM}"
    
    # Delete previous volume to save space
    if [ \$VOLUME_NUM -gt 1 ]; then
        if [ \$VOLUME_NUM -eq 2 ]; then
            PREV_VOLUME_FILE="\${VOLUMES_DIR}/\${BASE_NAME}.tar"
        else
            PREV_NUM=\$((VOLUME_NUM - 1))
            PREV_VOLUME_FILE="\${VOLUMES_DIR}/\${BASE_NAME}.tar-\${PREV_NUM}"
        fi
        
        if [ -f "\$PREV_VOLUME_FILE" ]; then
            echo "[Extract] Deleting previous volume: \${PREV_VOLUME_FILE}" >&2
            rm -f "\$PREV_VOLUME_FILE"
        fi
    fi
fi

# Check if volume already exists (shouldn't happen, but just in case)
if [ ! -f "\$VOLUME_FILE" ]; then
    echo "[Extract] Volume \${VOLUME_NUM} not ready, downloading..." >&2
    
    # Determine artifact name based on volume number
    ARTIFACT_NAME="\${ARTIFACT_BASE}-vol\$(printf '%03d' \$VOLUME_NUM)"
    
    # Download and decompress using Node.js helper
    # Environment variables are already set from sourcing the env file
    NODE_PATH="${tempDir}/node_modules" node "\${TEMP_DIR}/download-volume.js" "\$VOLUME_NUM" "\$ARTIFACT_NAME" "\$VOLUME_FILE" >&2
    
    if [ \$? -ne 0 ]; then
        echo "[Extract] ERROR: Failed to download volume \${VOLUME_NUM}" >&2
        exit 1
    fi
fi

# Return volume path to tar
echo "\$VOLUME_FILE" >&"\$TAR_FD"
`;
    
    await fs.writeFile(extractScriptPath, extractScript);
    await exec.exec('chmod', ['+x', extractScriptPath]);
    
    // Download first volume before starting extraction
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
    
    // Extract using multi-volume mode
    console.log('\n=== Extracting Multi-Volume Archive ===');
    console.log('tar will download subsequent volumes on-demand via the info script...');
    
    await exec.exec('tar', ['-xM', '-f', firstVolumePath, '-F', extractScriptPath, '-C', workDir]);
    
    console.log('✓ Extraction complete');
    
    // Cleanup
    await io.rmRF(tempDir);
    console.log('✓ Cleaned up temporary files');
    console.log('\n✓ Multi-volume extraction complete');
}

async function run() {
    process.on('SIGINT', function() {
    });

    const JOB_START_TIME = Date.now();
    const MAX_BUILD_TIME = 300 * 60 * 1000;
    
    const finished = core.getBooleanInput('finished', {required: true});
    const from_artifact = core.getBooleanInput('from_artifact', {required: true});
    
    // Read Brave version from brave_version.txt in the repository
    const versionFile = path.join('/home/runner/work/peasant-brave-portablelinux/peasant-brave-portablelinux', 'brave_version.txt');
    let brave_version = '';
    try {
        brave_version = (await fs.readFile(versionFile, 'utf-8')).trim();
        console.log(`Building Brave version: ${brave_version} (from brave_version.txt)`);
    } catch (e) {
        core.setFailed(`Failed to read brave_version.txt: ${e.message}`);
        return;
    }
    
    console.log(`finished: ${finished}, from_artifact: ${from_artifact}`);
    
    if (finished) {
        core.setOutput('finished', true);
        return;
    }

    const artifact = new DefaultArtifactClient();
    const artifactName = 'build-artifact';
    const workDir = '/home/runner/brave-build';
    const srcDir = path.join(workDir, 'src');
    const braveDir = path.join(srcDir, 'brave');

    try {
        await io.mkdirP(srcDir);
    } catch (e) {
        console.log('Work directory already exists');
    }
   
    if (from_artifact) {
        console.log('Downloading and extracting previous build artifact...');
        try {
            // Install zstd for decompression (needed before extraction)
            console.log('Installing zstd for decompression...');
            await exec.exec('sudo', ['apt-get', 'update'], {ignoreReturnCode: true});
            await exec.exec('sudo', ['apt-get', 'install', '-y', 'zstd', 'ncdu'], {ignoreReturnCode: true});
            
            // Extract multi-volume archive
            await extractMultiVolumeArchive(workDir, artifact, artifactName);

            console.log('Installing build dependencies...');
            await exec.exec('sudo', [path.join(workDir, 'src', 'build', 'install-build-deps.sh'), '--no-prompt']);

            // console.log('Installing npm dependencies...');
            // await exec.exec('npm', ['ci'], {
            //     cwd: braveDir,
            //     ignoreReturnCode: true
            // });
        } catch (e) {
            console.error(`Failed to download/extract artifact: ${e}`);
            throw e;
        }
    } else {
        // First stage: clone brave-core and initialize following official structure
        console.log('Initializing Brave build environment...');
        
        // Set environment variables for Brave build
        core.exportVariable('PYTHONUNBUFFERED', '1');
        core.exportVariable('GSUTIL_ENABLE_LUCI_AUTH', '0');
        
        // Install required system dependencies (per Brave Linux docs)
        console.log('Installing base build dependencies...');
        await exec.exec('sudo', ['apt-get', 'update'], {ignoreReturnCode: true});
        await exec.exec('sudo', ['apt-get', 'install', '-y', 
            'build-essential', 'git', 'python3', 'python3-pip', 
            'python-setuptools', 'python3-distutils', 'python-is-python3',
            'curl', 'lsb-release', 'sudo', 'tzdata', 'wget', 'ncdu', 'zstd'], {ignoreReturnCode: true});

        // Clone brave-core to src/brave (following official structure)
        // Brave uses tags with 'v' prefix (e.g., v1.85.74)
        const braveTag = brave_version.startsWith('v') ? brave_version : `v${brave_version}`;
        console.log(`Cloning brave-core tag ${braveTag} to ${braveDir}...`);
        await exec.exec('git', ['clone', '--branch', braveTag, '--depth=2',
            'https://github.com/brave/brave-core.git', braveDir], {
            ignoreReturnCode: true
        });

        // Install npm dependencies in brave-core
        console.log('Installing npm dependencies...');
        await exec.exec('npm', ['install'], {
            cwd: braveDir,
            ignoreReturnCode: true
        });
    }

    // Create a marker file to track build progress
    const markerFile = path.join(workDir, 'build-stage.txt');
    let currentStage = 'init';
    
    try {
        const markerContent = await fs.readFile(markerFile, 'utf-8');
        currentStage = markerContent.trim();
        console.log(`Resuming from stage: ${currentStage}`);
    } catch (e) {
        console.log('Starting from init stage');
    }

    let buildSuccess = false;

    try {
        // Stage 1: npm run init (downloads Chromium and dependencies)
        // On Linux, this runs WITHOUT timeout (exempt)
        if (currentStage === 'init') {
            console.log('=== Stage: npm run init ===');
            console.log('Running npm run init with --no-history...');
            
            const initCode = await exec.exec('npm', ['run', 'init', '--', '--no-history'], {
                cwd: braveDir,
                ignoreReturnCode: true
            });
            
            if (initCode === 0) {
                console.log('✓ npm run init completed successfully');
                
                // Install Chromium build dependencies (required after npm run init)
                console.log('Installing Chromium build dependencies...');
                const buildDepsScript = path.join(srcDir, 'build', 'install-build-deps.sh');
                const buildDepsCode = await exec.exec('sudo', [buildDepsScript, '--no-prompt', '--no-chromeos-fonts'], {
                    cwd: srcDir,
                    ignoreReturnCode: true
                });
                
                if (buildDepsCode === 0) {
                    console.log('✓ Chromium build dependencies installed');
                } else {
                    console.log(`⚠️ install-build-deps.sh returned code ${buildDepsCode}, trying --unsupported flag...`);
                    // Try with --unsupported for non-standard distros
                    await exec.exec('sudo', [buildDepsScript, '--no-prompt', '--no-chromeos-fonts', '--unsupported'], {
                        cwd: srcDir,
                        ignoreReturnCode: true
                    });
                }
                
                // Clean up unnecessary directories to free disk space
                console.log('\n=== Cleaning up unnecessary directories ===');
                const cleanupDirs = [
                    path.join(srcDir, 'ios'),
                    path.join(srcDir, 'third_party', 'jdk')
                ];
                
                for (const dir of cleanupDirs) {
                    console.log(`Removing ${dir}...`);
                    await exec.exec('rm', ['-rf', dir], {ignoreReturnCode: true});
                }
                
                // Remove android_* directories using shell glob
                console.log(`Removing ${path.join(srcDir, 'third_party', 'android_*')}...`);
                await exec.exec('bash', ['-c', `rm -rf ${path.join(srcDir, 'third_party', 'android_*')}`], {ignoreReturnCode: true});
                
                console.log('Checking disk space after cleanup:');
                await exec.exec('df', ['-h', '/home/runner'], {ignoreReturnCode: true});
                console.log('===========================================\n');
                
                await fs.writeFile(markerFile, 'build');
                currentStage = 'build';
            } else {
                console.log(`✗ npm run init failed with code ${initCode}`);
                // Stay in init stage to retry
            }
        }

        // Stage 2: npm run build (compile Brave - component build by default)
        // Timeout = 4.5 hours - time already spent in this job
        if (currentStage === 'build') {
            const elapsedTime = Date.now() - JOB_START_TIME;
            let remainingTime = MAX_BUILD_TIME - elapsedTime;
            // TODO: temporary to test if builds are resumed correctly
            remainingTime = 11*60*1000
            
            console.log('=== Stage: npm run build ===');
            console.log(`Time elapsed in job: ${(elapsedTime / 3600000).toFixed(2)} hours`);
            console.log(`Remaining time calculated: ${(remainingTime / 3600000).toFixed(2)} hours`);
            
            // Apply timeout rules:
            // 1. If remaining time < 0, set to 10 minutes
            // 2. Minimum timeout is 10 minutes
            const MIN_TIMEOUT = 5 * 60 * 1000; // 10 minutes
            remainingTime = Math.max(remainingTime, MIN_TIMEOUT);
            
            if (remainingTime < MIN_TIMEOUT) {
                console.log(`⚠️ Remaining time (${(remainingTime / 60000).toFixed(1)} min) is less than minimum, setting to 10 minutes`);
                remainingTime = MIN_TIMEOUT;
            }
            
            const timeoutSeconds = Math.floor(remainingTime / 1000);
            console.log(`Final timeout: ${(timeoutSeconds / 60).toFixed(0)} minutes (${(timeoutSeconds / 3600).toFixed(2)} hours)`);
            
            // // Run disk usage analysis BEFORE build
            // const ncduBeforePath = path.join(workDir, `ncdu-before-build-${Date.now()}.json`);
            // await runNcduAnalysis(ncduBeforePath, '/');
            
            // // Upload pre-build disk analysis
            // try {
            //     await artifact.uploadArtifact(`disk-usage-before-linux-${Date.now()}`, [ncduBeforePath], workDir, 
            //         {retentionDays: 7, compressionLevel: 0});
            //     console.log('Uploaded pre-build disk analysis');
            // } catch (e) {
            //     console.log(`Failed to upload pre-build analysis: ${e.message}`);
            // }
            
            console.log('Running npm run build (component build)...');
            
        
            const buildCode = await execWithTimeout('npm', ['run', 'build'], {
                cwd: braveDir,
                timeoutSeconds: timeoutSeconds
            })
        
            // // Run disk usage analysis AFTER build (regardless of success/timeout/failure)
            // const ncduAfterPath = path.join(workDir, `ncdu-after-build-${Date.now()}.json`);
            // await runNcduAnalysis(ncduAfterPath, '/');
            
            // // Upload post-build disk analysis
            // try {
            //     await artifact.uploadArtifact(`disk-usage-after-linux-${Date.now()}`, [ncduAfterPath], workDir, 
            //         {retentionDays: 7, compressionLevel: 0});
            //     console.log('Uploaded post-build disk analysis');
            // } catch (e) {
            //     console.log(`Failed to upload post-build analysis: ${e.message}`);
            // }
            
            if (buildCode === 0) {
                console.log('✓ npm run build completed successfully');
                await fs.writeFile(markerFile, 'package');
                currentStage = 'package';
                buildSuccess = true;
            } else if (buildCode === 124) {
                // Exit code 124 = timeout (per Linux timeout command convention)
                console.log('⏱️ npm run build timed out - will resume in next stage');
                
                // Wait for processes to finish cleanup (ninja may still be writing)
                console.log('Waiting 30 seconds for build processes to finish cleanup...');
                await new Promise(r => setTimeout(r, 10000));
                
                // Force filesystem sync to ensure partial build state is saved
                console.log('Syncing filesystem after timeout...');
                await exec.exec('sync', [], {ignoreReturnCode: true});
                await new Promise(r => setTimeout(r, 10000));

                await exec.exec('sync', [], {ignoreReturnCode: true});
                await new Promise(r => setTimeout(r, 10000));

                
                // Stay in build stage for next run
            } else {
                console.log(`✗ npm run build failed with code ${buildCode}`);
                // Stay in build stage to retry
            }
        }

    } catch (e) {
        console.error(`Build error: ${e.message}`);
    }

    if (buildSuccess && currentStage === 'package') {
        console.log('Build completed successfully, packaging artifacts...');
        
        // Find built executable
        const outDir = path.join(srcDir, 'out', 'Component');
        const braveExe = path.join(outDir, 'brave');
        
        try {
            await fs.access(braveExe);
            console.log(`Found brave executable at ${braveExe}`);
            
            // Create a tarball of the built browser
            const packageName = `brave-browser-${brave_version}-linux-x64.tar.xz`;
            const packagePath = path.join(workDir, packageName);
            
            console.log(`Creating package: ${packageName}`);
            await exec.exec('tar', ['-cJf', packagePath, 
                '-C', outDir, 'brave', 'chrome_crashpad_handler',
                'libEGL.so', 'libGLESv2.so', 'libvk_swiftshader.so',
                'libvulkan.so.1', 'locales', 'resources.pak',
                'chrome_100_percent.pak', 'chrome_200_percent.pak',
                'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin'],
                {ignoreReturnCode: true});
            
            // Upload final artifact
            const packageList = [packagePath];
            
            for (let i = 0; i < 5; ++i) {
                try {
                    await artifact.deleteArtifact('brave-browser-linux');
                } catch (e) {
                    // ignored
                }
                try {
                    await artifact.uploadArtifact('brave-browser-linux', packageList, workDir, 
                        {retentionDays: 7, compressionLevel: 0});
                    console.log('Successfully uploaded final artifact');
                    break;
                } catch (e) {
                    console.error(`Upload artifact failed: ${e}`);
                    await new Promise(r => setTimeout(r, 10000));
                }
            }
            
            core.setOutput('finished', true);
        } catch (e) {
            console.error(`Package creation failed: ${e.message}`);
            buildSuccess = false;
        }
    }
    
    if (!buildSuccess) {
        console.log('Build incomplete, creating checkpoint artifact...');
        
        await new Promise(r => setTimeout(r, 5000));
        
        // Force filesystem sync to ensure all build data is written (like macOS does)
        console.log('Syncing filesystem to flush all writes...');
        await exec.exec('sync', [], {ignoreReturnCode: true});
        await new Promise(r => setTimeout(r, 10000));
        console.log('Second sync for robustness...');
        await exec.exec('sync', [], {ignoreReturnCode: true});
        await new Promise(r => setTimeout(r, 10000));
        
        // Clean up caches before archiving (like ungoogled-chromium does)
        // console.log('Cleaning up download caches to save disk space...');
        // await exec.exec('rm', ['-rf', 
        //     path.join(srcDir, 'download_cache'),
        //     path.join(srcDir, 'build', 'download_cache')
        // ], {ignoreReturnCode: true});
        
        // Delete any existing artifacts from previous attempts
        console.log('Cleaning up previous artifacts...');
        try {
            // Delete manifest
            await artifact.deleteArtifact(`${artifactName}-manifest`);
        } catch (e) {
            // ignored
        }
        
        // Try to delete volume artifacts (up to 20 volumes)
        for (let vol = 1; vol <= 20; vol++) {
            try {
                const volName = `${artifactName}-vol${vol.toString().padStart(3, '0')}`;
                await artifact.deleteArtifact(volName);
            } catch (e) {
                // ignored
            }
        }
        
        // Create multi-volume archive with streaming compression and upload
        console.log('\nCreating multi-volume checkpoint artifact...');
        console.log('This will:');
        console.log('  1. Create 5GB tar volumes');
        console.log('  2. Compress each volume with zstd');
        console.log('  3. Upload compressed volume');
        console.log('  4. Delete volume files immediately');
        console.log('  5. Repeat for each volume\n');
        
        try {
            const volumeCount = await createMultiVolumeArchive(
                'build-state',
                workDir,
                ['src', 'build-stage.txt'],
                artifact,
                artifactName
            );
            console.log(`\n✓ Successfully created and uploaded ${volumeCount} volume(s)`);
        } catch (e) {
            console.error(`Failed to create multi-volume archive: ${e.message}`);
            core.setFailed(`Archive creation failed: ${e.message}`);
        }
        
        core.setOutput('finished', false);
    }
}

run().catch(err => core.setFailed(err.message));


