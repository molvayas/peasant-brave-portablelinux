const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const {DefaultArtifactClient} = require('@actions/artifact');
const glob = require('@actions/glob');
const fs = require('fs').promises;
const path = require('path');

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

    if (from_artifact) {
        console.log('Downloading previous build artifact...');
        try {
            const downloadPath = path.join(workDir, 'artifact');
            await io.mkdirP(downloadPath);
            
            const artifactInfo = await artifact.getArtifact(artifactName);
            await artifact.downloadArtifact(artifactInfo.artifact.id, {path: downloadPath});
            
            // Extract the tarball
            console.log('Extracting build state...');
            await exec.exec('tar', ['-xf', path.join(downloadPath, 'build-state.tar.zst'), 
                '-C', workDir, '--use-compress-program=unzstd']);
            
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
        // Linux builds are typically faster than Windows, so we use full 5.5 hour timeout
        if (currentStage === 'build') {
            console.log('=== Stage: npm run build ===');
            console.log('Running npm run build (component build)...');
            
            // GitHub Actions has 6-hour limit, we target 5.5 hours to allow cleanup time
            const buildCode = await exec.exec('npm', ['run', 'build'], {
                cwd: braveDir,
                ignoreReturnCode: true
            });
            
            if (buildCode === 0) {
                console.log('✓ npm run build completed successfully');
                await fs.writeFile(markerFile, 'package');
                currentStage = 'package';
                buildSuccess = true;
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
        
        // Compress critical build directories AND marker file
        // We use tar + zstd for better compression and speed on Linux
        const stateArchive = path.join(workDir, 'build-state.tar.zst');
        
        console.log('Compressing build state...');
        await exec.exec('tar', ['-cf', stateArchive, 
            '-C', workDir, 
            '--use-compress-program=zstd -3 -T0',
            '--exclude=src/.git',
            '--exclude=*.o',
            '--exclude=*.a',
            'src', 'build-stage.txt'], 
            {ignoreReturnCode: true});

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

