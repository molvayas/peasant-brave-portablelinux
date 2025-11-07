/**
 * Linux-specific build implementation for Brave Browser
 */

const exec = require('@actions/exec');
const core = require('@actions/core');
const fs = require('fs').promises;
const path = require('path');
const {getPlatformConfig, getBuildPaths, STAGES, getTimeouts, isWSL} = require('../config/constants');
const {cleanupDirectories} = require('../utils/disk');
const {execWithTimeout, calculateBuildTimeout, waitAndSync} = require('../utils/exec');

class LinuxBuilder {
    constructor(braveVersion, arch = 'x64') {
        this.braveVersion = braveVersion;
        this.arch = arch;
        this.platform = 'linux';
        this.isWSL = isWSL();
        this.config = getPlatformConfig(this.platform);  // Will auto-detect WSL
        // buildType will be set by orchestrator after construction
        this.buildType = 'Component';
        // jobStartTime will be set by orchestrator after construction
        this.jobStartTime = null;
        // envConfig will be set by orchestrator after construction
        this.envConfig = '';
        // paths will be set after buildType is known
        this.paths = null;
    }
    
    /**
     * Initialize paths based on buildType
     */
    _ensurePaths() {
        if (!this.paths) {
            this.paths = getBuildPaths(this.platform, this.buildType);
        }
    }

    /**
     * Initialize the build environment
     */
    async initialize() {
        this._ensurePaths();
        console.log('=== Initializing Linux Build Environment ===');
        console.log(`Brave version: ${this.braveVersion}`);
        console.log(`Architecture: ${this.arch}`);
        console.log(`Build type: ${this.buildType}`);
        console.log(`Work directory: ${this.paths.workDir}`);
        
        if (this.isWSL) {
            console.log('🐧 Running in WSL environment');
            console.log(`Volume size for archives: ${this.config.volumeSize} (larger due to D: drive space)`);
            if (this.config.vhdSize) {
                console.log(`Virtual disk: ${this.config.vhdSize} ext4 filesystem`);
            }
        } else {
            console.log('🐧 Running on native Linux');
            console.log(`Volume size for archives: ${this.config.volumeSize}`);
        }
        
        // Install base dependencies
        await this._installBaseDependencies();
        
        // Clone brave-core
        await this._cloneBraveCore();
        
        // Install npm dependencies
        await this._installNpmDependencies();
    }

    /**
     * Run npm run init stage
     */
    async runInit() {
        console.log('\n=== Stage: npm run init ===');
        console.log('Running npm run init with --no-history...');
        
        const initCode = await exec.exec('npm', ['run', 'init', '--', '--no-history'], {
            cwd: this.paths.braveDir,
            ignoreReturnCode: true
        });
        
        if (initCode !== 0) {
            console.log(`✗ npm run init failed with code ${initCode}`);
            return false;
        }
        
        console.log('✓ npm run init completed successfully');
        
        // Install Chromium build dependencies
        await this._installChromiumDeps();
        
        // Clean up unnecessary directories
        await this._cleanupAfterInit();
        
        return true;
    }

    /**
     * Run npm run build stage
     */
    async runBuild() {
        this._ensurePaths();
        console.log('\n=== Stage: npm run build ===');
        
        // Calculate timeout based on time elapsed since job start
        // This ensures we account for time spent on init, downloads, etc.
        if (!this.jobStartTime) {
            throw new Error('jobStartTime not set! Orchestrator must set this before calling runBuild()');
        }
        
        const timeouts = getTimeouts(this.platform);
        const timing = calculateBuildTimeout(
            this.jobStartTime,
            timeouts.MAX_BUILD_TIME,
            timeouts.MIN_BUILD_TIME
        );
        
        console.log(`Time elapsed in job: ${timing.elapsedHours} hours`);
        console.log(`Remaining time calculated: ${timing.remainingHours} hours`);
        console.log(`Final timeout: ${timing.timeoutMinutes} minutes (${timing.remainingHours} hours)`);
        
        // Build command based on buildType
        let buildArgs;
        if (this.buildType === 'Release') {
            // Release: build browser and create distribution package in one go
            // Limit to 3 jobs to prevent runner heartbeat starvation on 4-core GitHub runners
            buildArgs = ['run', 'build', 'Release', '--', '--target=create_dist', '--skip_signing', '--ninja', 'j:3', '--gn', 'symbol_level:0', '--gn', 'blink_symbol_level:0', '--gn', 'v8_symbol_level:0'];
            console.log('Running npm run build Release with create_dist (unified)...');
            console.log('Note: Unified for consistency with macOS after Xcode initialization fix');
            console.log('Note: Building with symbol_level=0, blink_symbol_level=0, v8_symbol_level=0 to reduce build size and time');
            console.log('Note: Limited to -j3 (via --ninja j:3) to prevent GitHub runner heartbeat loss on 4-core runners');
        } else {
            // Component: just build
            // Limit to 3 jobs to prevent runner heartbeat starvation on 4-core GitHub runners
            buildArgs = ['run', 'build', '--', '--ninja', 'j:3', '--gn', 'symbol_level:0', '--gn', 'blink_symbol_level:0', '--gn', 'v8_symbol_level:0'];
            console.log('Running npm run build (component)...');
            console.log('Note: Building with symbol_level=0, blink_symbol_level=0, v8_symbol_level=0 to reduce build size and time');
            console.log('Note: Limited to -j3 (via --ninja j:3) to prevent GitHub runner heartbeat loss on 4-core runners');
        }
        
        console.log(`Command: npm ${buildArgs.join(' ')}`);
        
        const buildCode = await execWithTimeout('npm', buildArgs, {
            cwd: this.paths.braveDir,
            timeoutSeconds: timing.timeoutSeconds
        });
        
        if (buildCode === 0) {
            console.log('✓ npm run build completed successfully');
            return {success: true, timedOut: false};
        } else if (buildCode === 124) {
            // Timeout
            console.log('⏱️ npm run build timed out - will resume in next stage');
            
            // Wait for processes to finish cleanup
            const timeouts = getTimeouts(this.platform);
            await waitAndSync(timeouts.CLEANUP_WAIT);
            await waitAndSync(timeouts.SYNC_WAIT);
            
            return {success: false, timedOut: true};
        } else {
            console.log(`✗ npm run build failed with code ${buildCode}`);
            return {success: false, timedOut: false};
        }
    }

    /**
     * Run create_dist stage (Release builds only)
     * NOTE: As of the unified build approach, create_dist is now unified with runBuild()
     * This method is kept for compatibility but just returns success.
     */
    async runBuildDist() {
        this._ensurePaths();
        console.log('\n=== Stage: create_dist (unified with build, no-op) ===');
        
        if (this.buildType !== 'Release') {
            console.log('Skipping create_dist - not a Release build');
            return {success: true, timedOut: false};
        }
        
        console.log('create_dist already completed in unified build step');
        console.log('✓ Distribution package already created');
        return {success: true, timedOut: false};
    }

    /**
     * Package the built browser
     */
    async package() {
        this._ensurePaths();
        console.log('\n=== Stage: Package ===');
        
        if (this.buildType === 'Release') {
            // Release builds: grab distribution package
            // Linux creates the zip in out/Release/ directly (via deb build script)
            console.log('Packaging Release build...');
            
            // Linux: The deb build script creates a zip in out/Release/ directly
            // Format: brave-browser[-stable]-{version}-linux-{debarch}.zip
            //   where debarch = "amd64" for x64, "arm64" for arm64
            const outputDir = path.join(this.paths.srcDir, 'out', 'Release');
            
            // Strip any leading 'v' from version
            const versionWithoutV = this.braveVersion.startsWith('v') 
                ? this.braveVersion.substring(1) 
                : this.braveVersion;
            
            // Convert arch to Debian arch naming
            const debArch = this.arch === 'x64' ? 'amd64' : this.arch;
            
            // Try both possible filenames (with and without -stable suffix)
            const possibleNames = [
                `brave-browser-${versionWithoutV}-linux-${debArch}.zip`,
                `brave-browser-stable-${versionWithoutV}-linux-${debArch}.zip`
            ];
            
            let distZipPath = null;
            let expectedZipName = null;
            
            for (const name of possibleNames) {
                const testPath = path.join(outputDir, name);
                try {
                    await fs.access(testPath);
                    distZipPath = testPath;
                    expectedZipName = name;
                    break;
                } catch (e) {
                    // Try next name
                }
            }
            
            if (distZipPath) {
                console.log(`✓ Found distribution package: ${expectedZipName}`);
            } else {
                // Fallback: search for any brave-browser*.zip in out/Release/
                console.log(`Distribution package not found with expected names`);
                console.log(`Looking for: ${possibleNames.join(', ')}`);
                console.log(`Searching in ${outputDir}...`);
                try {
                    const files = await fs.readdir(outputDir);
                    console.log('Files in out/Release:', files.filter(f => f.endsWith('.zip')));
                    // Try to find any brave-browser*.zip file
                    const zipFile = files.find(f => f.startsWith('brave-browser') && f.endsWith('.zip') && !f.includes('symbols'));
                    if (zipFile) {
                        console.log(`Using found zip file: ${zipFile}`);
                        distZipPath = path.join(outputDir, zipFile);
                        expectedZipName = zipFile;
                    }
                } catch (e2) {
                    console.error('Error listing out/Release:', e2.message);
                }
                
                if (!distZipPath) {
                    throw new Error(`Distribution package not found. Expected one of: ${possibleNames.join(', ')}`);
                }
            }
            
            // Copy to work directory with standardized name
            const packageName = `brave-browser-${this.braveVersion}-${this.platform}-${this.arch}.zip`;
            const packagePath = path.join(this.paths.workDir, packageName);
            
            await fs.copyFile(distZipPath, packagePath);
            console.log('✓ Package copied successfully');
            
            return {
                packagePath,
                packageName
            };
            
        } else {
            // Component builds: create tarball from entire out directory (exclude obj)
            console.log('Packaging Component build from output directory...');
            
            const outDir = path.join(this.paths.srcDir, 'out');
            
            try {
                await fs.access(outDir);
                console.log(`Found out directory at ${outDir}`);
            } catch (e) {
                throw new Error(`Out directory not found at ${outDir}`);
            }
            
            // Create tarball of entire out directory, excluding obj folders
            const packageName = `brave-out-${this.braveVersion}-${this.platform}-${this.arch}.${this.config.packageFormat}`;
            const packagePath = path.join(this.paths.workDir, packageName);
            
            console.log(`Creating package: ${packageName}`);
            console.log('Archiving entire out directory (excluding obj folders)...');
            
            await exec.exec('tar', [
                '-cJf', packagePath,
                '--exclude=out/*/obj',  // Exclude obj directories
                '-C', this.paths.srcDir,
                'out'
            ], {
                ignoreReturnCode: true,
                env: {
                    ...process.env,
                    LC_ALL: 'C'
                }
            });
            
            console.log('✓ Package created successfully');
            
            return {
                packagePath,
                packageName
            };
        }
    }

    /**
     * Read current build stage from marker file
     */
    async getCurrentStage() {
        this._ensurePaths();
        try {
            const markerContent = await fs.readFile(this.paths.markerFile, 'utf-8');
            const stage = markerContent.trim();
            console.log(`Resuming from stage: ${stage}`);
            return stage;
        } catch (e) {
            console.log('Starting from init stage');
            return STAGES.INIT;
        }
    }

    /**
     * Update build stage marker
     */
    async setStage(stage) {
        this._ensurePaths();
        await fs.writeFile(this.paths.markerFile, stage);
        console.log(`✓ Updated stage marker to: ${stage}`);
    }

    // ========================================================================
    // Private methods
    // ========================================================================

    async _installBaseDependencies() {
        console.log('Installing base build dependencies...');
        await exec.exec('sudo', ['apt-get', 'update'], {ignoreReturnCode: true});
        await exec.exec('sudo', ['apt-get', 'install', '-y', ...this.config.dependencies], {
            ignoreReturnCode: true
        });
        console.log('✓ Base dependencies installed');
    }

    async _cloneBraveCore() {
        const braveTag = this.braveVersion.startsWith('v') ? this.braveVersion : `v${this.braveVersion}`;
        console.log(`Cloning brave-core tag ${braveTag} to ${this.paths.braveDir}...`);
        
        await exec.exec('git', [
            'clone',
            '--branch', braveTag,
            '--depth=2',
            'https://github.com/brave/brave-core.git',
            this.paths.braveDir
        ], {ignoreReturnCode: true});
        
        console.log('✓ brave-core cloned');
    }

    async _installNpmDependencies() {
        console.log('Installing npm dependencies...');
        await exec.exec('npm', ['install'], {
            cwd: this.paths.braveDir,
            ignoreReturnCode: true
        });
        console.log('✓ npm dependencies installed');
    }

    async _installChromiumDeps() {
        console.log('Installing Chromium build dependencies...');
        const buildDepsScript = path.join(this.paths.srcDir, 'build', 'install-build-deps.sh');
        
        const buildDepsCode = await exec.exec('sudo', [
            buildDepsScript,
            '--no-prompt',
            '--no-chromeos-fonts'
        ], {
            cwd: this.paths.srcDir,
            ignoreReturnCode: true
        });
        
        if (buildDepsCode === 0) {
            console.log('✓ Chromium build dependencies installed');
        } else {
            console.log(`⚠️ install-build-deps.sh returned code ${buildDepsCode}, trying --unsupported flag...`);
            await exec.exec('sudo', [
                buildDepsScript,
                '--no-prompt',
                '--no-chromeos-fonts',
                '--unsupported'
            ], {
                cwd: this.paths.srcDir,
                ignoreReturnCode: true
            });
        }
    }

    async _cleanupAfterInit() {
        await cleanupDirectories(this.paths.srcDir, this.config.cleanupDirs);
    }
}

module.exports = LinuxBuilder;

