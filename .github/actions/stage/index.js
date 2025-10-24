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

async function run() {
    process.on('SIGINT', function() {
    });
    
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

    // Free up disk space on GitHub Actions runner
    // Ubuntu runners have ~14GB free, but Brave needs ~100GB
    // Removing unused tools frees up ~25-30GB
    const buildDirLocation = '/home/runner';
    
    console.log('=== Disk Space Management ===');
    console.log(`Build directory: ${workDir}`);
    console.log(`Checking disk space for: ${buildDirLocation}`);
    console.log('\nBEFORE cleanup:');
    await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
    
    console.log('\nFreeing disk space on runner...\n');
    const cleanupDirs = [
        {path: '/usr/share/dotnet', name: '.NET SDK'},
        {path: '/usr/local/lib/android', name: 'Android SDK'},
        {path: '/usr/local/.ghcup', name: 'GHC/Haskell'},
        {path: '/usr/lib/jvm', name: 'Java JDKs'},
        {path: '/usr/lib/google-cloud-sdk', name: 'Google Cloud SDK'},
        {path: '/usr/share/swift', name: 'Swift'},
        {path: '/opt/ghc', name: 'GHC (opt)'},
        {path: '/opt/hostedtoolcache/CodeQL', name: 'CodeQL'}
    ];
    
    for (const {path: dir, name} of cleanupDirs) {
        try {
            console.log(`Removing ${name} (${dir})...`);
            console.log('  Before:');
            await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
            
            await exec.exec('sudo', ['rm', '-rf', dir], {ignoreReturnCode: true});
            
            console.log('  After:');
            await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
            console.log('');
        } catch (e) {
            console.log(`  Skipped (doesn't exist or already removed)\n`);
        }
    }
    
    // Prune Docker images
    console.log('Pruning Docker images...');
    console.log('  Before:');
    await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
    try {
        await exec.exec('sudo', ['docker', 'image', 'prune', '--all', '--force'], {ignoreReturnCode: true});
    } catch (e) {
        console.log('  Docker not available');
    }
    console.log('  After:');
    await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
    
    console.log('\n✓ Cleanup complete');
    console.log(`FINAL disk space available for ${workDir}:`);
    await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
    console.log('===========================\n');

    if (from_artifact) {
        console.log('Downloading previous build artifact...');
        try {
            const downloadPath = path.join(workDir, 'artifact');
            await io.mkdirP(downloadPath);
            
            const artifactInfo = await artifact.getArtifact(artifactName);
            await artifact.downloadArtifact(artifactInfo.artifact.id, {path: downloadPath});
            
            // Extract the tarball (using pipe like ungoogled-chromium)
            console.log('Extracting build state...');
            const archivePath = path.join(downloadPath, 'build-state.tar.zst');
            await exec.exec('sh', ['-c', `zstd -d -c "${archivePath}" | tar -xf - -C "${workDir}"`]);
            
            await io.rmRF(downloadPath);
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
            'curl', 'lsb-release', 'sudo', 'tzdata', 'wget'], {ignoreReturnCode: true});

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
    const JOB_START_TIME = Date.now();
    const MAX_JOB_TIME = 270 * 60 * 1000; // 4.5 hours in milliseconds

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
            let remainingTime = MAX_JOB_TIME - elapsedTime;
            
            console.log('=== Stage: npm run build ===');
            console.log(`Time elapsed in job: ${(elapsedTime / 3600000).toFixed(2)} hours`);
            console.log(`Remaining time calculated: ${(remainingTime / 3600000).toFixed(2)} hours`);
            
            // Apply timeout rules:
            // 1. If remaining time < 0, set to 10 minutes
            // 2. Minimum timeout is 10 minutes
            const MIN_TIMEOUT = 10 * 60 * 1000; // 10 minutes
            remainingTime = Math.max(remainingTime, MIN_TIMEOUT);
            
            if (remainingTime < MIN_TIMEOUT) {
                console.log(`⚠️ Remaining time (${(remainingTime / 60000).toFixed(1)} min) is less than minimum, setting to 10 minutes`);
                remainingTime = MIN_TIMEOUT;
            }
            
            const timeoutSeconds = Math.floor(remainingTime / 1000);
            console.log(`Final timeout: ${(timeoutSeconds / 60).toFixed(0)} minutes (${(timeoutSeconds / 3600).toFixed(2)} hours)`);
            console.log('Running npm run build (component build)...');
            
            const buildCode = await execWithTimeout('npm', ['run', 'build'], {
                cwd: braveDir,
                timeoutSeconds: timeoutSeconds
            });
            
            if (buildCode === 0) {
                console.log('✓ npm run build completed successfully');
                await fs.writeFile(markerFile, 'package');
                currentStage = 'package';
                buildSuccess = true;
            } else if (buildCode === 124) {
                // Exit code 124 = timeout (per Linux timeout command convention)
                console.log('⏱️ npm run build timed out - will resume in next stage');
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
        
        // Compress critical build directories AND marker file (using pipe like ungoogled-chromium)
        // IMPORTANT: Do NOT exclude .o files - they ARE the build progress!
        // IMPORTANT: Include src/.git to match Windows (which includes everything)
        // Using pipe for tar+zstd is more reliable than --use-compress-program
        const stateArchive = path.join(workDir, 'build-state.tar.zst');
        
        console.log('Compressing build state...');
        await exec.exec('sh', ['-c', 
            `cd "${workDir}" && tar -cf - src build-stage.txt | zstd -f -T0 -3 -o "${stateArchive}"`
        ], {ignoreReturnCode: true});

        // Upload intermediate artifact
        for (let i = 0; i < 5; ++i) {
            try {
                await artifact.deleteArtifact(artifactName);
            } catch (e) {
                // ignored
            }
            try {
                await artifact.uploadArtifact(artifactName, [stateArchive], workDir, 
                    {retentionDays: 1, compressionLevel: 0});
                console.log('Successfully uploaded checkpoint artifact');
                break;
            } catch (e) {
                console.error(`Upload artifact failed: ${e}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
        
        core.setOutput('finished', false);
    }
}

run().catch(err => core.setFailed(err.message));

