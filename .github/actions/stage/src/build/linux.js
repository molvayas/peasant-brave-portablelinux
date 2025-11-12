/**
 * Linux-specific Brave Browser Builder
 */

const exec = require('@actions/exec');
const core = require('@actions/core');
const fs = require('fs').promises;
const path = require('path');
const {getPlatformConfig, getBuildPaths, STAGES, getTimeouts, isWSL} = require('../config/constants');
const {cleanupDirectories} = require('../utils/disk');
const {execWithTimeout, calculateBuildTimeout, waitAndSync} = require('../utils/exec');

class LinuxBuilder {
    /**
     * Initialize Linux-specific builder with platform detection
     *
     * @param {string} braveVersion - Brave version tag to build (e.g., "v1.50.100")
     * @param {string} arch - Target architecture (x64, arm64)
     */
    constructor(braveVersion, arch = 'x64') {
        this.braveVersion = braveVersion;
        this.arch = arch;
        this.platform = 'linux';

        // Auto-detect WSL environment for optimized configuration
        this.isWSL = isWSL();
        this.config = getPlatformConfig(this.platform);  // Auto-detects WSL and applies config

        // These properties are set by the orchestrator after construction
        this.buildType = 'Component';    // Component (dev) or Release (production)
        this.jobStartTime = null;        // For timeout calculations
        this.envConfig = '';             // .env file contents
        this.paths = null;               // Build paths (set after buildType is known)
    }
    
    /**
     * Ensure build paths are initialized based on current buildType
     *
     * Build paths depend on buildType (Component vs Release) because Chromium
     * organizes output directories differently for different build configurations.
     * This method is called lazily to ensure paths are available when needed.
     *
     * @private
     */
    _ensurePaths() {
        if (!this.paths) {
            this.paths = getBuildPaths(this.platform, this.buildType);
        }
    }

    /**
     * Initialize the complete Linux build environment
     *
     * @returns {Promise<void>} Completes when environment is fully initialized
     */
    async initialize() {
        this._ensurePaths();
        console.log('=== Initializing Linux Build Environment ===');
        console.log(`Brave version: ${this.braveVersion}`);
        console.log(`Architecture: ${this.arch}`);
        console.log(`Build type: ${this.buildType}`);
        console.log(`Work directory: ${this.paths.workDir}`);
        
        if (this.isWSL) {
            console.log('LINUX: Running in WSL environment');
            console.log(`Volume size for archives: ${this.config.volumeSize} (larger due to D: drive space)`);
            if (this.config.vhdSize) {
                console.log(`Virtual disk: ${this.config.vhdSize} ext4 filesystem`);
            }
        } else {
            console.log('LINUX: Running on native Linux');
            console.log(`Volume size for archives: ${this.config.volumeSize}`);
        }
        
        // Install base dependencies
        await this._installBaseDependencies();
        
        // Clone brave-core
        await this._cloneBraveCore();
        
        // Apply custom patches
        await this._applyPatches();
        
        // Install npm dependencies
        await this._installNpmDependencies();
    }

    /**
     * Execute the npm run init stage - setup Chromium build environment
     *
     * @returns {Promise<boolean>} true if initialization successful, false if failed
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
     * Execute the npm run build stage
     *
     * @returns {Promise<{success: boolean, timedOut: boolean}>}
     *         success: true if build completed successfully
     *         timedOut: true if build timed out (can be resumed)
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
            // Release: build browser and create distribution package in one go with full optimizations
            buildArgs = [
                'run', 'build', 'Release', '--', 
                '--target_arch=' + this.arch, 
                '--target=create_dist', 
                '--skip_signing',
                // Critical optimization flags (these trigger -O3 and LTO automatically)
                '--gn', 'is_official_build:true',      // CRITICAL: Enables -O3, LTO, and all optimizations
                '--gn', 'dcheck_always_on:false',      // Disable expensive debug checks
                // no thanks, we don't debug here
                '--gn', 'symbol_level:0',
                '--gn', 'blink_symbol_level:0',
                '--gn', 'v8_symbol_level:0',
                '--gn', 'should_generate_symbols:false',
                '--gn', 'brave_p3a_enabled:false'
            ];
            console.log('Running npm run build Release with create_dist (OPTIMIZED)...');
            console.log(`Note: Building for ${this.arch} architecture`);
            console.log('Note: [OPT] Official build optimizations ENABLED (fast & small binary)');
            console.log('Note: is_official_build=true, is_debug=false, dcheck_always_on=false');
            console.log('Note: Symbol generation disabled for maximum speed');
        } else {
            // Component: just build
            buildArgs = ['run', 'build', '--', '--target_arch=' + this.arch, '--gn', 'symbol_level:0', '--gn', 'blink_symbol_level:0', '--gn', 'v8_symbol_level:0', '--gn', 'should_generate_symbols:false'];
            console.log('Running npm run build (component)...');
            console.log(`Note: Building for ${this.arch} architecture`);
            console.log('Note: Building with symbol_level=0, blink_symbol_level=0, v8_symbol_level=0 to reduce build size and time');
            console.log('Note: Disabled should_generate_symbols to skip symbol generation');
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
            console.log('TIMEOUT: npm run build timed out - will resume in next stage');
            
            // Check disk space before archiving
            console.log('\n=== Checking disk space ===');
            await exec.exec('df', ['-h', this.paths.srcDir], {ignoreReturnCode: true});
            console.log('\n=== Disk usage in out directory ===');
            await exec.exec('du', ['-sh', path.join(this.paths.srcDir, 'out')], {ignoreReturnCode: true});
            await exec.exec('du', ['-h', '--max-depth=1', path.join(this.paths.srcDir, 'out')], {ignoreReturnCode: true});
            
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
     * Package the compiled browser into distributable artifacts
     *
     * @returns {Promise<{packagePath: string, packageName: string}>}
     *         packagePath: Absolute path to the created package file
     *         packageName: Standardized package filename
     */
    async package() {
        this._ensurePaths();
        console.log('\n=== Stage: Package ===');
        
        if (this.buildType === 'Release') {
            // Release builds: grab distribution package
            // Linux creates the zip in out/Release/ or out/Release_{arch}/ (via deb build script)
            console.log('Packaging Release build...');
            
            // Linux: The deb build script creates a zip in out/Release/ or out/Release_{arch}/
            // Format: brave-browser[-stable]-{version}-linux-{debarch}.zip
            //   where debarch = "amd64" for x64, "arm64" for arm64
            // Brave's build system naming:
            // - x64: out/Release/ (no suffix, default)
            // - arm64: out/Release_arm64/ (with suffix)
            // - x86: out/Release_x86/ (with suffix)
            const possibleOutputDirs = [
                path.join(this.paths.srcDir, 'out', 'Release')  // Always try default first
            ];
            if (this.arch !== 'x64') {
                possibleOutputDirs.push(path.join(this.paths.srcDir, 'out', `Release_${this.arch}`));
            }
            
            // Strip any leading 'v' from version
            const versionWithoutV = this.braveVersion.startsWith('v') 
                ? this.braveVersion.substring(1) 
                : this.braveVersion;
            
            // Convert arch to Debian arch naming
            const debArch = this.arch === 'x64' ? 'amd64' : this.arch;
            
            // Try both possible filenames (with and without -stable suffix)
            // Note: Build system creates brave-browser-* files, we rename to raven-* when copying
            const possibleNames = [
                `brave-browser-${versionWithoutV}-linux-${debArch}.zip`,
                `brave-browser-stable-${versionWithoutV}-linux-${debArch}.zip`
            ];
            
            let distZipPath = null;
            let expectedZipName = null;
            let foundInDir = null;
            
            // Try all possible output directories with expected names
            for (const outputDir of possibleOutputDirs) {
                for (const name of possibleNames) {
                    const testPath = path.join(outputDir, name);
                    try {
                        await fs.access(testPath);
                        distZipPath = testPath;
                        expectedZipName = name;
                        foundInDir = outputDir;
                        console.log(`✓ Found distribution package: ${expectedZipName} in ${outputDir}`);
                        break;
            } catch (e) {
                        // Try next name/directory
                    }
                }
                if (distZipPath) break;
            }
            
            if (!distZipPath) {
                // Fallback 1: search for any brave-browser*.zip in known possible directories
                console.log(`Distribution package not found with expected names`);
                console.log(`Looking for: ${possibleNames.join(', ')}`);
                
                for (const outputDir of possibleOutputDirs) {
                    console.log(`Searching in ${outputDir}...`);
                    try {
                        const files = await fs.readdir(outputDir);
                        console.log(`Files in ${outputDir}:`, files.filter(f => f.endsWith('.zip')));
                        // Try to find any brave-browser*.zip file
                        const zipFile = files.find(f => f.startsWith('brave-browser') && f.endsWith('.zip') && !f.includes('symbols'));
                    if (zipFile) {
                        console.log(`Using found zip file: ${zipFile}`);
                            distZipPath = path.join(outputDir, zipFile);
                            expectedZipName = zipFile;
                            foundInDir = outputDir;
                            break;
                        }
                    } catch (e2) {
                        // Directory doesn't exist or can't be read, try next
                    }
                }
                
                // Fallback 2: scan for ANY Release* directory in out/
                if (!distZipPath) {
                    console.log(`Fallback: scanning for any Release* directory in out/...`);
                    const outDir = path.join(this.paths.srcDir, 'out');
                    try {
                        const allDirs = await fs.readdir(outDir, { withFileTypes: true });
                        const releaseDirs = allDirs
                            .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('Release'))
                            .map(dirent => path.join(outDir, dirent.name));
                        
                        console.log(`Found Release directories: ${releaseDirs.join(', ')}`);
                        
                        for (const releaseDir of releaseDirs) {
                            console.log(`Checking ${releaseDir}...`);
                            try {
                                const files = await fs.readdir(releaseDir);
                                const zipFile = files.find(f => f.startsWith('brave-browser') && f.endsWith('.zip') && !f.includes('symbols'));
                                if (zipFile) {
                                    console.log(`✓ Found zip file in ${releaseDir}: ${zipFile}`);
                                    distZipPath = path.join(releaseDir, zipFile);
                                    expectedZipName = zipFile;
                                    foundInDir = releaseDir;
                                    break;
                                }
                            } catch (e3) {
                                // Can't read this directory, try next
                            }
                    }
                } catch (e2) {
                        console.log(`Could not scan out/ directory: ${e2.message}`);
                    }
                }
                
                if (!distZipPath) {
                    throw new Error(`Distribution package not found. Tried: ${possibleOutputDirs.join(', ')}, and all Release* directories`);
                }
            }
            
            // Copy to work directory with standardized name
            const packageName = `raven-${this.braveVersion}-${this.platform}-${this.arch}.zip`;
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
            const packageName = `raven-out-${this.braveVersion}-${this.platform}-${this.arch}.${this.config.packageFormat}`;
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
                    LC_ALL: 'C',
                    XZ_OPT: '-T2'  // Limit xz compression to 2 threads (leaves resources for runner)
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
    // Private methods - Linux-specific implementation details
    // ========================================================================

    /**
     * Install base system dependencies required for Chromium builds
     *
     * Chromium has extensive native dependencies that must be installed
     * at the system level. This includes compilers, libraries, and build tools
     * that cannot be installed via npm.
     *
     * @private
     */
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

    async _applyPatches() {
        console.log('=== Applying Custom Patches ===');
        
        // Paths to patches (repo root contains patches/, scripts/, series)
        const repoRoot = process.env.GITHUB_WORKSPACE;
        const patchesDir = path.join(repoRoot, 'patches');
        const seriesFile = path.join(repoRoot, 'series');
        
        // Check if patches exist
        try {
            await fs.access(patchesDir);
            await fs.access(seriesFile);
        } catch (e) {
            console.log('ℹ No custom patches found, skipping patch application');
            return;
        }
        
        // Set up quilt environment
        const quiltEnv = {
            ...process.env,
            QUILT_PATCHES: patchesDir,
            QUILT_SERIES: seriesFile,
            QUILT_PC: path.join(this.paths.braveDir, '.pc')
        };
        
        console.log(`Patches directory: ${patchesDir}`);
        console.log(`Series file: ${seriesFile}`);
        console.log(`Brave directory: ${this.paths.braveDir}`);
        
        // Apply all patches using quilt
        const patchCode = await exec.exec('quilt', ['push', '-a'], {
            cwd: this.paths.braveDir,
            env: quiltEnv,
            ignoreReturnCode: true
        });
        
        if (patchCode === 0) {
            console.log('✓ All custom patches applied successfully');
        } else {
            console.error(`✗ Patch application failed with code ${patchCode}`);
            throw new Error('Failed to apply custom patches');
        }
    }

    async _installNpmDependencies() {
        console.log('Installing npm dependencies...');
        await exec.exec('npm', ['install'], {
            cwd: this.paths.braveDir,
            ignoreReturnCode: true
        });
        console.log('✓ npm dependencies installed');
    }

    /**
     * Install Chromium-specific build dependencies using Google's official script
     *
     * @private
     */
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
        
        // Install sysroot for cross-compilation if needed
        const os = require('os');
        const hostArch = os.arch(); // 'x64', 'arm64', etc.
        
        if (this.arch !== hostArch) {
            console.log(`\n=== Installing sysroot for cross-compilation (host: ${hostArch}, target: ${this.arch}) ===`);
            const sysrootScript = path.join(this.paths.srcDir, 'build', 'linux', 'sysroot_scripts', 'install-sysroot.py');
            
            // Map our arch names to Chromium's sysroot arch names
            const sysrootArch = this.arch === 'x64' ? 'amd64' : this.arch;
            
            await exec.exec('python3', [
                sysrootScript,
                `--arch=${sysrootArch}`
            ], {
                cwd: this.paths.srcDir,
                ignoreReturnCode: true
            });
            
            console.log(`✓ Sysroot for ${this.arch} installed`);
        } else {
            console.log(`Native build (host arch matches target arch: ${this.arch}), no sysroot needed`);
        }
    }

    async _cleanupAfterInit() {
        await cleanupDirectories(this.paths.srcDir, this.config.cleanupDirs);
    }
}

module.exports = LinuxBuilder;

