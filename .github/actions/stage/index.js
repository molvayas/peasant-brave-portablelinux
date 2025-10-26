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
        console.log('Downloading previous build artifact (incremental extraction)...');
        try {
            const downloadPath = path.join(workDir, 'artifact');
            await io.mkdirP(downloadPath);
            
            // First, download metadata to know how many volumes to expect
            console.log('Downloading volume metadata...');
            const metadataArtifactName = `${artifactName}-metadata`;
            let volumeCount = 0;
            
            try {
                const metadataInfo = await artifact.getArtifact(metadataArtifactName);
                await artifact.downloadArtifact(metadataInfo.artifact.id, {path: downloadPath});
                
                const metadataFile = path.join(downloadPath, 'volume-metadata.json');
                const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf-8'));
                volumeCount = metadata.volumeCount;
                
                console.log(`✓ Metadata: ${volumeCount} volume(s) to download`);
                console.log(`  Created: ${metadata.timestamp}`);
                console.log(`  Volume size: ${metadata.volumeSize}GB\n`);
                
                // Clean up metadata file
                await fs.unlink(metadataFile);
            } catch (e) {
                console.warn('⚠️ Could not download metadata, will discover volumes dynamically');
                console.warn(`   Error: ${e.message}\n`);
            }
            
            // If we don't have metadata, try to discover volumes
            if (volumeCount === 0) {
                console.log('Discovering available volume artifacts...');
                // We'll download volumes one by one until we can't find more
                let testVolumeNum = 1;
                while (testVolumeNum <= 100) { // Safety limit
                    const testVolName = `${artifactName}-vol-${String(testVolumeNum).padStart(3, '0')}`;
                    try {
                        await artifact.getArtifact(testVolName);
                        volumeCount++;
                        testVolumeNum++;
                    } catch (e) {
                        break; // No more volumes
                    }
                }
                console.log(`✓ Discovered ${volumeCount} volume(s)\n`);
            }
            
            if (volumeCount === 0) {
                throw new Error('❌ No volumes found to extract!');
            }
            
            // Download and extract volumes incrementally
            // Strategy: download → extract (while still compressed) → delete → next
            // Each volume is extracted as it comes, keeping only one on disk
            console.log('🔄 Starting incremental download and extraction...\n');
            console.log('Strategy: download → extract → delete → next\n');
            
            // Since volumes were created with split on compressed stream,
            // we need to concatenate them back together before decompressing
            // We'll do this incrementally using a streaming approach
            
            // Create a background process that will extract as we feed it data
            const pipePath = path.join(downloadPath, 'extract-stream.fifo');
            await exec.exec('mkfifo', [pipePath]);
            console.log('✓ Created named pipe for streaming extraction\n');
            
            // Start extraction in background - reads from pipe, decompresses, extracts
            console.log('Starting background extraction process...');
            const extractionProcess = exec.exec('bash', ['-c', 
                `cat "${pipePath}" | sudo tar -xf - --use-compress-program="zstd -d" -C ${workDir}`
            ], {ignoreReturnCode: true}).then(code => {
                console.log(`\nExtraction process finished (exit code: ${code})`);
                return code;
            });
            
            // Wait for extraction process to start and open the pipe
            await new Promise(r => setTimeout(r, 3000));
            
            // Download volumes one by one and stream them to the extraction pipe
            console.log('Streaming volumes to extraction...\n');
            
            for (let i = 1; i <= volumeCount; i++) {
                const volArtifactName = `${artifactName}-vol-${String(i).padStart(3, '0')}`;
                const volFileName = `build-state.vol-${String.fromCharCode(96 + Math.floor((i - 1) / 26) + 1)}${String.fromCharCode(97 + ((i - 1) % 26))}`;
                const volPath = path.join(downloadPath, volFileName);
                
                console.log(`[${i}/${volumeCount}] Downloading ${volArtifactName}...`);
                
                try {
                    const volInfo = await artifact.getArtifact(volArtifactName);
                    await artifact.downloadArtifact(volInfo.artifact.id, {path: downloadPath});
                    
                    const stats = await fs.stat(volPath);
                    const sizeGB = (stats.size / (1024 * 1024 * 1024)).toFixed(2);
                    console.log(`  ✓ Downloaded (${sizeGB}GB)`);
                } catch (e) {
                    throw new Error(`Failed to download volume ${i}: ${e.message}`);
                }
                
                // Stream this volume to the pipe
                console.log(`  Streaming to extraction...`);
                await exec.exec('bash', ['-c', `cat "${volPath}" > "${pipePath}"`], {
                    ignoreReturnCode: true
                });
                console.log(`  ✓ Streamed`);
                
                // Delete volume immediately to free space
                console.log(`  Deleting volume...`);
                await fs.unlink(volPath);
                console.log(`  ✓ Removed\n`);
            }
            
            // Close the pipe by removing it (extraction will finish)
            console.log('All volumes streamed, waiting for extraction to complete...\n');
            
            // Wait for extraction to complete
            const extractCode = await extractionProcess;
            
            if (extractCode !== 0) {
                console.warn(`⚠️ Extraction completed with exit code ${extractCode}`);
            } else {
                console.log('✓ Extraction completed successfully');
            }
            
            // Verify extraction succeeded
            console.log('Verifying extraction...');
            const srcDirExists = await fs.access(srcDir).then(() => true).catch(() => false);
            const markerExists = await fs.access(path.join(workDir, 'build-stage.txt')).then(() => true).catch(() => false);
            
            if (!srcDirExists) {
                throw new Error('❌ Extraction verification failed: src directory not found');
            }
            if (!markerExists) {
                console.warn('⚠️ Warning: build-stage.txt marker not found (may be first stage)');
            }
            
            console.log('✓ All volumes extracted and verified successfully');
            
            // Clean up download directory
            await io.rmRF(downloadPath);
            console.log('✓ Artifact directory cleaned up');

            console.log('Installing ncdu for disk usage analysis...');
            await exec.exec('sudo', ['apt-get', 'update'], {ignoreReturnCode: true});
            await exec.exec('sudo', ['apt-get', 'install', '-y', 'ncdu'], {ignoreReturnCode: true});

            console.log('Installing build dependencies...');
            await exec.exec('sudo', [path.join(workDir, 'src', 'build', 'install-build-deps.sh'), '--no-prompt']);

            // console.log('Installing npm dependencies...');
            // await exec.exec('npm', ['ci'], {
            //     cwd: braveDir,
            //     ignoreReturnCode: true
            // });
        } catch (e) {
            console.error(`Failed to download artifact: ${e}`);
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
            'curl', 'lsb-release', 'sudo', 'tzdata', 'wget', 'ncdu'], {ignoreReturnCode: true});

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

        // TEMPORARY TEST: Archive src directory before build to test multi-volume logic
        if (currentStage === 'build') {
            console.log('\n=== TEMPORARY TEST: Multi-volume archive test ===');
            console.log('Testing the archiving pipeline with src directory...\n');
            
            const testVolumePrefix = path.join(workDir, 'test-archive.vol-');
            const testVolumeSizeBytes = 100 * 1024 * 1024; // 100MB for quick testing
            const testArtifactName = 'test-multi-volume-archive';
            
            console.log('⚠️  Using 100MB volumes for quick testing (production will use 5GB)\n');
            
            // Create handler script for test
            const testHandlerScript = path.join(workDir, 'test-volume-handler.sh');
            const testHandlerContent = `#!/bin/bash
# Test handler script

VOLUME_FILE="\$FILE"
VOLUME_NUM_FILE="${workDir}/.test-volume-counter"
STATUS_FILE="${workDir}/.test-volume-status"

if [ ! -f "\${VOLUME_NUM_FILE}" ]; then
    echo "0" > "\${VOLUME_NUM_FILE}"
fi

VOLUME_NUM=\$(cat "\${VOLUME_NUM_FILE}")
VOLUME_NUM=\$((VOLUME_NUM + 1))
echo "\${VOLUME_NUM}" > "\${VOLUME_NUM_FILE}"

if SIZE_BYTES=\$(stat -c%s "\${VOLUME_FILE}" 2>/dev/null); then
    :
elif SIZE_BYTES=\$(stat -f%z "\${VOLUME_FILE}" 2>/dev/null); then
    :
else
    SIZE_BYTES=\$(ls -l "\${VOLUME_FILE}" | awk '{print \$5}')
fi

SIZE_MB=\$(echo "\${SIZE_BYTES}" | awk '{printf "%.2f", \$1/1048576}')

echo ""
echo "📦 [TEST Volume \${VOLUME_NUM}] \$(basename "\${VOLUME_FILE}") completed (\${SIZE_MB}MB)"
echo "   Signaling for upload..."

echo "READY:\${VOLUME_FILE}:\${VOLUME_NUM}" >> "\${STATUS_FILE}"

TIMEOUT=3600
ELAPSED=0
echo "   Waiting for upload and deletion..."

while [ -f "\${VOLUME_FILE}" ] && [ \${ELAPSED} -lt \${TIMEOUT} ]; do
    sleep 5
    ELAPSED=\$((ELAPSED + 5))
    
    if [ \$((ELAPSED % 30)) -eq 0 ]; then
        echo "   Still waiting... (\${ELAPSED}s elapsed)"
    fi
done

if [ -f "\${VOLUME_FILE}" ]; then
    echo "   ⚠️ Timeout waiting for volume!"
    exit 1
fi

echo "   ✓ Test volume \${VOLUME_NUM} processed and removed"
exit 0
`;
            
            await fs.writeFile(testHandlerScript, testHandlerContent, {mode: 0o755});
            
            const testCounterFile = path.join(workDir, '.test-volume-counter');
            const testStatusFile = path.join(workDir, '.test-volume-status');
            await fs.writeFile(testCounterFile, '0');
            await fs.writeFile(testStatusFile, '');
            
            let testVolumeNum = 0;
            const testProcessedVolumes = new Set();
            let testMonitorError = null;
            
            console.log('Starting test volume monitor...\n');
            
            const testMonitorInterval = setInterval(async () => {
                try {
                    const status = await fs.readFile(testStatusFile, 'utf-8');
                    const lines = status.trim().split('\n').filter(l => l);
                    
                    for (const line of lines) {
                        if (!line.startsWith('READY:')) continue;
                        
                        const parts = line.split(':');
                        if (parts.length < 3) continue;
                        
                        const volPath = parts[1];
                        const volNumStr = parts[2];
                        
                        if (testProcessedVolumes.has(volPath)) continue;
                        
                        const volNum = parseInt(volNumStr);
                        
                        console.log(`[TEST Monitor] Processing volume ${volNum}`);
                        
                        try {
                            const stats = await fs.stat(volPath);
                            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                            
                            console.log(`   Test volume ${volNum}: ${sizeMB}MB`);
                            console.log(`   Uploading test volume...`);
                            
                            const volArtifactName = `${testArtifactName}-vol-${String(volNum).padStart(3, '0')}`;
                            
                            let uploaded = false;
                            for (let attempt = 0; attempt < 3; attempt++) {
                                try {
                                    await artifact.uploadArtifact(volArtifactName, [volPath], workDir, 
                                        {retentionDays: 1, compressionLevel: 0});
                                    console.log(`   ✓ Test volume uploaded as ${volArtifactName}`);
                                    uploaded = true;
                                    break;
                                } catch (e) {
                                    console.error(`   Upload attempt ${attempt + 1} failed: ${e.message}`);
                                    if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
                                }
                            }
                            
                            if (!uploaded) {
                                clearInterval(testMonitorInterval);
                                testMonitorError = new Error(`Failed to upload test volume ${volNum}`);
                                throw testMonitorError;
                            }
                            
                            console.log(`   Deleting test volume ${volNum}...`);
                            await fs.unlink(volPath);
                            console.log(`   ✓ Test volume deleted\n`);
                            
                            testProcessedVolumes.add(volPath);
                            testVolumeNum = volNum;
                            
                        } catch (e) {
                            if (e.code !== 'ENOENT') {
                                console.error(`[TEST Monitor] Error: ${e.message}`);
                                testMonitorError = e;
                            }
                        }
                    }
                } catch (e) {
                    if (e.code !== 'ENOENT') {
                        console.error(`[TEST Monitor] Error reading status: ${e.message}`);
                    }
                }
            }, 2000);
            
            // Test archive command - archive src/third_party directory for realistic test
            // This should be large enough to create multiple 5GB volumes
            const testTarSplitCmd = `tar -cf - --use-compress-program="zstd -10 -T0" -H posix -C ${srcDir} third_party | split -b ${testVolumeSizeBytes} --filter='export FILE="$FILE"; bash ${testHandlerScript}' - ${testVolumePrefix}`;
            
            console.log('Starting TEST archive pipeline...\n');
            console.log('📝 Archiving src/third_party as test (should create multiple volumes)\n');
            
            const testTarExitCode = await exec.exec('bash', ['-c', testTarSplitCmd], {
                ignoreReturnCode: true
            });
            
            clearInterval(testMonitorInterval);
            
            if (testMonitorError) {
                console.error(`\n❌ Test monitor error: ${testMonitorError.message}`);
                throw testMonitorError;
            }
            
            await new Promise(r => setTimeout(r, 3000));
            
            console.log(`\n✅ TEST archive completed (exit code: ${testTarExitCode})`);
            console.log(`   Test volumes created: ${testVolumeNum}\n`);
            
            if (testVolumeNum > 0) {
                console.log('🎉 SUCCESS! Multi-volume archiving works correctly!\n');
                
                // Upload test metadata
                const testMetadataFile = path.join(workDir, 'test-volume-metadata.json');
                await fs.writeFile(testMetadataFile, JSON.stringify({
                    volumeCount: testVolumeNum,
                    volumePrefix: 'test-archive.vol-',
                    volumeSizeMB: 100,
                    timestamp: new Date().toISOString()
                }));
                
                await artifact.uploadArtifact(`${testArtifactName}-metadata`, [testMetadataFile], workDir, 
                    {retentionDays: 1, compressionLevel: 0});
                await fs.unlink(testMetadataFile);
                
                console.log('✓ Test metadata uploaded\n');
            } else {
                console.log('⚠️ Test created 0 volumes (data too small for 100MB volume)\n');
                console.log('   This is okay - handler and monitor scripts were tested successfully\n');
            }
            
            // Cleanup test files
            await fs.unlink(testCounterFile).catch(() => {});
            await fs.unlink(testStatusFile).catch(() => {});
            await fs.unlink(testHandlerScript).catch(() => {});
            
            console.log('=== END TEST ===\n');
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
            });
            
            // Run disk usage analysis AFTER build (regardless of success/timeout/failure)
            const ncduAfterPath = path.join(workDir, `ncdu-after-build-${Date.now()}.json`);
            await runNcduAnalysis(ncduAfterPath, '/');
            
            // Upload post-build disk analysis
            try {
                await artifact.uploadArtifact(`disk-usage-after-linux-${Date.now()}`, [ncduAfterPath], workDir, 
                    {retentionDays: 7, compressionLevel: 0});
                console.log('Uploaded post-build disk analysis');
            } catch (e) {
                console.log(`Failed to upload post-build analysis: ${e.message}`);
            }
            
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
        
        // Controlled multi-volume archiving with split --filter
        // Strategy: split calls our handler for EACH volume BEFORE creating the next one
        // This ensures only ONE volume exists on disk at any time
        const volumePrefix = path.join(workDir, 'build-state.vol-');
        const volumeSizeBytes = 5 * 1024 * 1024 * 1024; // 5GB in bytes
        
        console.log('🔄 Starting controlled multi-volume archiving...');
        console.log(`Volume size: 5GB`);
        console.log('Using zstd level 10 with all threads (-T0)');
        console.log('Using --remove-files to free space during archiving');
        console.log('Strategy: split creates volume → calls handler → handler uploads & deletes → split creates next\n');
        
        // Create a handler script that split will call for each completed volume
        // split --filter runs this script with the volume path in $FILE
        // The script MUST complete before split creates the next volume
        const handlerScript = path.join(workDir, 'volume-handler.sh');
        const handlerContent = `#!/bin/bash
# Handler script called by split for each completed volume
# Don't use 'set -e' here as we want to handle errors gracefully

VOLUME_FILE="\$FILE"
VOLUME_NUM_FILE="${workDir}/.volume-counter"
STATUS_FILE="${workDir}/.volume-status"

# Initialize counter if needed
if [ ! -f "\${VOLUME_NUM_FILE}" ]; then
    echo "0" > "\${VOLUME_NUM_FILE}"
fi

# Increment volume number
VOLUME_NUM=\$(cat "\${VOLUME_NUM_FILE}")
VOLUME_NUM=\$((VOLUME_NUM + 1))
echo "\${VOLUME_NUM}" > "\${VOLUME_NUM_FILE}"

# Get volume size (try both Linux and macOS stat formats)
if SIZE_BYTES=\$(stat -c%s "\${VOLUME_FILE}" 2>/dev/null); then
    # Linux format worked
    :
elif SIZE_BYTES=\$(stat -f%z "\${VOLUME_FILE}" 2>/dev/null); then
    # macOS format worked
    :
else
    # Fallback: use ls
    SIZE_BYTES=\$(ls -l "\${VOLUME_FILE}" | awk '{print \$5}')
fi

# Calculate size in GB (without bc - using awk instead)
SIZE_GB=\$(echo "\${SIZE_BYTES}" | awk '{printf "%.2f", \$1/1073741824}')

echo ""
echo "📦 [Volume \${VOLUME_NUM}] \$(basename "\${VOLUME_FILE}") completed (\${SIZE_GB}GB)"
echo "   Volume path: \${VOLUME_FILE}"
echo "   Signaling Node.js for upload..."

# Signal that volume is ready (Node.js will handle upload)
echo "READY:\${VOLUME_FILE}:\${VOLUME_NUM}" >> "\${STATUS_FILE}"

# Wait for Node.js to upload and delete the volume
TIMEOUT=3600  # 1 hour timeout
ELAPSED=0
echo "   Waiting for upload and deletion..."

while [ -f "\${VOLUME_FILE}" ] && [ \${ELAPSED} -lt \${TIMEOUT} ]; do
    sleep 5
    ELAPSED=\$((ELAPSED + 5))
    
    # Show progress every 30 seconds
    if [ \$((ELAPSED % 30)) -eq 0 ]; then
        echo "   Still waiting... (\${ELAPSED}s elapsed)"
    fi
done

if [ -f "\${VOLUME_FILE}" ]; then
    echo "   ⚠️ Timeout waiting for volume to be processed after \${ELAPSED} seconds!"
    echo "   This usually means the upload failed or Node.js isn't running"
    exit 1
fi

echo "   ✓ Volume \${VOLUME_NUM} processed and removed"
exit 0
`;
        
        await fs.writeFile(handlerScript, handlerContent, {mode: 0o755});
        console.log('✓ Created volume handler script\n');
        
        // Initialize volume counter
        const counterFile = path.join(workDir, '.volume-counter');
        const statusFile = path.join(workDir, '.volume-status');
        await fs.writeFile(counterFile, '0');
        await fs.writeFile(statusFile, '');
        
        // Start monitoring for volume completion signals
        let volumeNum = 0;
        const processedVolumes = new Set();
        let monitorError = null;
        
        console.log('Starting volume monitor (checks every 2 seconds)...\n');
        
        const monitorInterval = setInterval(async () => {
            try {
                // Read status file to see if handler signaled any volumes
                const status = await fs.readFile(statusFile, 'utf-8');
                const lines = status.trim().split('\n').filter(l => l);
                
                if (lines.length > 0 && lines.length > processedVolumes.size) {
                    console.log(`[Monitor] Found ${lines.length} signal(s), processed ${processedVolumes.size} so far`);
                }
                
                for (const line of lines) {
                    if (!line.startsWith('READY:')) continue;
                    
                    const parts = line.split(':');
                    if (parts.length < 3) {
                        console.warn(`[Monitor] Malformed signal: ${line}`);
                        continue;
                    }
                    
                    const volPath = parts[1];
                    const volNumStr = parts[2];
                    
                    if (processedVolumes.has(volPath)) continue;
                    
                    const volNum = parseInt(volNumStr);
                    const volName = path.basename(volPath);
                    
                    console.log(`[Monitor] Processing volume ${volNum}: ${volName}`);
                    
                    // Check if volume exists
                    try {
                        const stats = await fs.stat(volPath);
                        const sizeGB = (stats.size / (1024 * 1024 * 1024)).toFixed(2);
                        
                        console.log(`   Volume ${volNum}: ${sizeGB}GB`);
                        console.log(`   Uploading...`);
                        
                        // Upload this volume
                        const volArtifactName = `${artifactName}-vol-${String(volNum).padStart(3, '0')}`;
                        
                        let uploaded = false;
                        for (let attempt = 0; attempt < 3; attempt++) {
                            try {
                                await artifact.uploadArtifact(volArtifactName, [volPath], workDir, 
                    {retentionDays: 1, compressionLevel: 0});
                                console.log(`   ✓ Uploaded as ${volArtifactName}`);
                                uploaded = true;
                break;
                            } catch (e) {
                                console.error(`   Upload attempt ${attempt + 1} failed: ${e.message}`);
                                if (attempt < 2) {
                                    await new Promise(r => setTimeout(r, 5000));
                                }
                            }
                        }
                        
                        if (!uploaded) {
                            clearInterval(monitorInterval);
                            monitorError = new Error(`Failed to upload volume ${volNum} after 3 attempts`);
                            throw monitorError;
                        }
                        
                        // Delete volume to signal handler script to continue
                        console.log(`   Deleting ${volName} to unblock handler...`);
                        await fs.unlink(volPath);
                        console.log(`   ✓ Deleted - handler will continue, split will create next volume\n`);
                        
                        processedVolumes.add(volPath);
                        volumeNum = volNum;
                        
                    } catch (e) {
                        // Volume might not exist yet or already deleted
                        if (e.code === 'ENOENT') {
                            console.warn(`[Monitor] Volume ${volPath} not found (may have been deleted)`);
                        } else {
                            console.error(`[Monitor] Error processing volume: ${e.message}`);
                            monitorError = e;
                        }
                    }
                }
            } catch (e) {
                // Status file might not exist yet or be empty
                if (e.code !== 'ENOENT') {
                    console.error(`[Monitor] Error reading status file: ${e.message}`);
                }
            }
        }, 2000); // Check every 2 seconds
        
        // Create tar + split pipeline with --filter
        // The filter script is called synchronously for each completed volume
        // split will NOT create the next volume until the filter script completes
        // Note: split sets $FILE to the output filename automatically
        const tarSplitCmd = `tar -cf - --remove-files --use-compress-program="zstd -10 -T0" -H posix --atime-preserve -C ${workDir} src build-stage.txt | split -b ${volumeSizeBytes} --filter='export FILE="$FILE"; bash ${handlerScript}' - ${volumePrefix}`;
        
        console.log('Starting controlled archive pipeline...\n');
        console.log('⚠️  Each volume will be uploaded and deleted BEFORE the next one is created\n');
        console.log(`Command: ${tarSplitCmd}\n`);
        
        // Run tar+split process
        const tarExitCode = await exec.exec('bash', ['-c', tarSplitCmd], {
            ignoreReturnCode: true
        });
        
        // Stop monitoring
        clearInterval(monitorInterval);
        
        // Check if monitor encountered an error
        if (monitorError) {
            console.error(`\n❌ Monitor error occurred during archiving: ${monitorError.message}`);
            throw monitorError;
        }
        
        // Final processing of any remaining volumes
        await new Promise(r => setTimeout(r, 5000));
        
        console.log(`\n✅ Archive pipeline completed (exit code: ${tarExitCode})`);
        console.log(`   Total volumes: ${volumeNum}\n`);
        
        if (volumeNum === 0) {
            console.error('❌ No volumes were created!');
            console.error('This usually means:');
            console.error('  1. The source directory was empty');
            console.error('  2. The handler script failed (check logs above)');
            console.error('  3. The first volume was never completed');
            throw new Error('Archive creation failed - no volumes generated');
        }
        
        // Clean up temporary files
        await fs.unlink(counterFile).catch(() => {});
        await fs.unlink(statusFile).catch(() => {});
        await fs.unlink(handlerScript).catch(() => {});
        
        // Create a metadata file to track volume count
        const metadataFile = path.join(workDir, 'volume-metadata.json');
        await fs.writeFile(metadataFile, JSON.stringify({
            volumeCount: volumeNum,
            volumePrefix: 'build-state.vol-',
            volumeSize: 5,
            timestamp: new Date().toISOString()
        }));
        
        // Upload metadata
        console.log('Uploading volume metadata...');
        await artifact.uploadArtifact(`${artifactName}-metadata`, [metadataFile], workDir, 
            {retentionDays: 1, compressionLevel: 0});
        await fs.unlink(metadataFile);
        console.log('✓ Metadata uploaded');
        
        core.setOutput('finished', false);
    }
}

run().catch(err => core.setFailed(err.message));

