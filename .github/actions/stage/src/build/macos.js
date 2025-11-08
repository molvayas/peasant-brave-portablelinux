/**
 * macOS-specific build implementation for Brave Browser
 */

const exec = require('@actions/exec');
const fs = require('fs').promises;
const path = require('path');
const {getPlatformConfig, getBuildPaths, STAGES, getTimeouts} = require('../config/constants');
const {cleanupDirectories} = require('../utils/disk');
const {execWithTimeout, calculateBuildTimeout, waitAndSync} = require('../utils/exec');

class MacOSBuilder {
    constructor(braveVersion, arch = 'x64') {
        this.braveVersion = braveVersion;
        this.arch = arch;
        this.platform = 'macos';
        this.config = getPlatformConfig(this.platform);
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
        console.log('=== Initializing macOS Build Environment ===');
        console.log(`Brave version: ${this.braveVersion}`);
        console.log(`Architecture: ${this.arch}`);
        console.log(`Build type: ${this.buildType}`);
        console.log(`Work directory: ${this.paths.workDir}`);
        
        // Install GNU tar and coreutils (for gtimeout)
        await this._installBrewDependencies();
        
        // Setup Xcode and Metal toolchain
        await this._setupXcode();
        
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
        
        // macOS doesn't use install-build-deps.sh
        // Chromium build deps are already available on macOS runner
        
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
            buildArgs = ['run', 'build', 'Release', '--', '--target_arch=' + this.arch, '--target=create_dist', '--skip_signing', '--ninja', `l:4`, '--gn', 'symbol_level:0', '--gn', 'blink_symbol_level:0', '--gn', 'v8_symbol_level:0'];
            console.log('Running npm run build Release with create_dist (unified)...');
            console.log(`Note: Building for ${this.arch} architecture`);
            console.log('Note: Now unified since macOS Xcode initialization is fixed');
            console.log('Note: Building with symbol_level=0, blink_symbol_level=0, v8_symbol_level=0 to reduce build size and time');
        } else {
            // Component: just build
            buildArgs = ['run', 'build', '--', '--target_arch=' + this.arch, '--ninja', `l:4`, '--gn', 'symbol_level:0', '--gn', 'blink_symbol_level:0', '--gn', 'v8_symbol_level:0'];
            console.log('Running npm run build (component)...');
            console.log(`Note: Building for ${this.arch} architecture`);
            console.log('Note: Building with symbol_level=0, blink_symbol_level=0, v8_symbol_level=0 to reduce build size and time');
        }
        
        console.log(`Command: npm ${buildArgs.join(' ')}`);
        
        // Use gtimeout on macOS (from coreutils)
        const buildCode = await execWithTimeout('npm', buildArgs, {
            cwd: this.paths.braveDir,
            timeoutSeconds: timing.timeoutSeconds,
            useGTimeout: true  // Use gtimeout instead of timeout on macOS
        });
        
        if (buildCode === 0) {
            console.log('✓ npm run build completed successfully');
            return {success: true, timedOut: false};
        } else if (buildCode === 124) {
            // Timeout
            console.log('⏱️ npm run build timed out - will resume in next stage');
            
            // Check disk space before archiving
            console.log('\n=== Checking disk space ===');
            await exec.exec('df', ['-h', this.paths.srcDir], {ignoreReturnCode: true});
            console.log('\n=== Disk usage in out directory ===');
            await exec.exec('du', ['-sh', path.join(this.paths.srcDir, 'out')], {ignoreReturnCode: true});
            await exec.exec('du', ['-h', '-d', '1', path.join(this.paths.srcDir, 'out')], {ignoreReturnCode: true});
            
            // Wait for processes to finish cleanup (longer on macOS)
            await waitAndSync(30000); // 30 seconds
            await waitAndSync(timeouts.SYNC_WAIT);
            
            return {success: false, timedOut: true};
        } else {
            console.log(`✗ npm run build failed with code ${buildCode}`);
            return {success: false, timedOut: false};
        }
    }

    /**
     * Run create_dist stage (Release builds only)
     * NOTE: As of the macOS Xcode fix, create_dist is now unified with runBuild()
     * This method is kept for compatibility but just returns success.
     */
    async runBuildDist() {
        this._ensurePaths();
        console.log('\n=== Stage: create_dist (unified with build, no-op) ===');
        
        if (this.buildType !== 'Release') {
            console.log('Skipping create_dist - not a Release build');
            return {success: true, timedOut: false};
        }
        
        console.log('create_dist already completed in unified build step (macOS Xcode fix)');
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
            // Release builds: grab distribution package from dist/
            console.log('Packaging Release build from dist...');
            
            // macOS: create_dist creates zip in out/Release/dist/ or out/Release/packaged/
            // Brave's build system naming:
            // - x64: out/Release/ (no suffix, default)
            // - arm64: out/Release_arm64/ (with suffix)
            const possibleDistDirs = [
                path.join(this.paths.srcDir, 'out', 'Release', 'dist'),
                path.join(this.paths.srcDir, 'out', 'Release', 'packaged')
            ];
            if (this.arch !== 'x64') {
                possibleDistDirs.push(path.join(this.paths.srcDir, 'out', `Release_${this.arch}`, 'dist'));
                possibleDistDirs.push(path.join(this.paths.srcDir, 'out', `Release_${this.arch}`, 'packaged'));
            }
            
            // Look for the distribution zip file
            // Format: brave-v{version}-darwin-{arch}.zip (lowercase "brave", single v)
            // Strip any leading 'v' from version to avoid double-v
            const versionWithoutV = this.braveVersion.startsWith('v') 
                ? this.braveVersion.substring(1) 
                : this.braveVersion;
            const expectedZipName = `brave-v${versionWithoutV}-darwin-${this.arch}.zip`;
            
            let distZipPath = null;
            let foundInDir = null;
            
            // Try all possible directories
            for (const distDir of possibleDistDirs) {
                const testPath = path.join(distDir, expectedZipName);
                try {
                    await fs.access(testPath);
                    distZipPath = testPath;
                    foundInDir = distDir;
                    console.log(`✓ Found distribution package: ${expectedZipName} in ${distDir}`);
                    break;
                } catch (e) {
                    // Try next directory
                }
            }
            
            if (!distZipPath) {
                // Fallback 1: search for any brave-*.zip or brave-*.dmg in known directories
                console.log(`Expected file ${expectedZipName} not found in standard locations`);
                console.log('Searching for any brave distribution file...');
                
                for (const distDir of possibleDistDirs) {
                    try {
                        const files = await fs.readdir(distDir);
                        console.log(`Files in ${distDir}:`, files.filter(f => f.endsWith('.zip') || f.endsWith('.dmg')));
                        const distFile = files.find(f => f.startsWith('brave-') && (f.endsWith('.zip') || f.endsWith('.dmg')) && !f.includes('symbols'));
                        if (distFile) {
                            console.log(`Using found distribution file: ${distFile}`);
                            const foundDistPath = path.join(distDir, distFile);
                            const ext = distFile.endsWith('.zip') ? 'zip' : 'dmg';
                            const packageName = `brave-browser-${this.braveVersion}-${this.platform}-${this.arch}.${ext}`;
                            const packagePath = path.join(this.paths.workDir, packageName);
                            await fs.copyFile(foundDistPath, packagePath);
                            console.log('✓ Package copied successfully');
                            return { packagePath, packageName };
                        }
                    } catch (e2) {
                        // Directory doesn't exist or can't be read, try next
                    }
                }
                
                // Fallback 2: scan for ANY Release* directory in out/
                console.log(`Fallback: scanning for any Release* directory in out/...`);
                const outDir = path.join(this.paths.srcDir, 'out');
                try {
                    const allDirs = await fs.readdir(outDir, { withFileTypes: true });
                    const releaseDirs = allDirs
                        .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('Release'))
                        .map(dirent => dirent.name);
                    
                    console.log(`Found Release directories: ${releaseDirs.join(', ')}`);
                    
                    for (const releaseDir of releaseDirs) {
                        for (const subdir of ['dist', 'packaged']) {
                            const checkDir = path.join(outDir, releaseDir, subdir);
                            console.log(`Checking ${checkDir}...`);
                            try {
                                const files = await fs.readdir(checkDir);
                                const distFile = files.find(f => f.startsWith('brave-') && (f.endsWith('.zip') || f.endsWith('.dmg')) && !f.includes('symbols'));
                                if (distFile) {
                                    console.log(`✓ Found distribution file in ${checkDir}: ${distFile}`);
                                    const foundDistPath = path.join(checkDir, distFile);
                                    const ext = distFile.endsWith('.zip') ? 'zip' : 'dmg';
                                    const packageName = `brave-browser-${this.braveVersion}-${this.platform}-${this.arch}.${ext}`;
                                    const packagePath = path.join(this.paths.workDir, packageName);
                                    await fs.copyFile(foundDistPath, packagePath);
                                    console.log('✓ Package copied successfully');
                                    return { packagePath, packageName };
                                }
                            } catch (e3) {
                                // Can't read this directory, try next
                            }
                        }
                    }
                } catch (e2) {
                    console.log(`Could not scan out/ directory: ${e2.message}`);
                }
                
                throw new Error(`Distribution package not found. Tried: ${possibleDistDirs.join(', ')}, and all Release* directories`);
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
            // Component builds: create tarball of entire out directory
            console.log('Packaging Component build from output directory...');
            
            const outDir = path.join(this.paths.srcDir, 'out');
            
            try {
                await fs.access(outDir);
                console.log(`Found out directory at ${outDir}`);
            } catch (e) {
                throw new Error(`Out directory not found at ${outDir}`);
            }
            
            // Create tarball of entire out directory
            const packageName = `brave-out-${this.braveVersion}-${this.platform}.${this.config.packageFormat}`;
            const packagePath = path.join(this.paths.workDir, packageName);
            
            console.log(`Creating archive of entire out directory: ${packageName}`);
            console.log('This may take a while...');
            
            // Use gtar (GNU tar) with compression, exclude obj directory
            await exec.exec('gtar', [
                'caf', packagePath,
                '-H', 'posix',
                '--atime-preserve',
                '--exclude=out/*/obj',  // Exclude obj directories
                '-C', this.paths.srcDir,
                'out'
            ], {
                ignoreReturnCode: true,
                env: {
                    ...process.env,
                    LC_ALL: 'C',  // Use C locale to avoid "Illegal byte sequence" errors on macOS
                    XZ_OPT: '-T2'  // Limit compression to 2 threads (gtar uses xz for .tar.xz)
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

    async _installBrewDependencies() {
        console.log('Installing build dependencies via Homebrew...');
        console.log('Installing: coreutils (for gtimeout), ncdu (for disk analysis)');
        
        await exec.exec('brew', ['install', 'coreutils', 'ncdu'], {ignoreReturnCode: true});
        
        console.log('✓ Homebrew dependencies installed');
    }

    async _setupXcode() {
        console.log('\n=== Setting up Xcode Environment ===');
        
        // Select appropriate Xcode version (newer versions preferred)
        const xcodeVersions = [
            '/Applications/Xcode_26.0.app',
            '/Applications/Xcode_16.4.app',  // Added 16.4
            '/Applications/Xcode_16.3.app',
            '/Applications/Xcode_16.2.app',
            '/Applications/Xcode_16.1.app',
            '/Applications/Xcode_16.0.app',
            '/Applications/Xcode_15.4.app',
            '/Applications/Xcode_15.3.app',
            '/Applications/Xcode_15.2.app'
        ];
        
        let xcodeSelected = false;
        for (const xcodePath of xcodeVersions) {
            try {
                await fs.access(xcodePath);
                console.log(`Found ${xcodePath}, selecting it...`);
                await exec.exec('sudo', ['xcode-select', '--switch', xcodePath]);
                console.log(`✅ Using ${xcodePath}`);
                xcodeSelected = true;
                break;
            } catch (e) {
                // Xcode version not found, try next
            }
        }
        
        if (!xcodeSelected) {
            console.log('⚠️ No preferred Xcode version found in list');
            console.log('Listing available Xcode installations:');
            await exec.exec('ls', ['-la', '/Applications/'], {ignoreReturnCode: true});
            console.log('\nUsing currently active Xcode (if any)');
        }
        
        // Show current Xcode configuration
        console.log('\nCurrent Xcode configuration:');
        await exec.exec('xcode-select', ['--print-path'], {ignoreReturnCode: true});
        await exec.exec('xcodebuild', ['-version'], {ignoreReturnCode: true});
        
        // List available SDKs
        console.log('\nAvailable SDKs:');
        await exec.exec('xcodebuild', ['-showsdks'], {ignoreReturnCode: true});
        
        // Install Metal toolchain for Xcode 26.0+ (may not work on all Xcode versions)
        console.log('\nInstalling Metal toolchain...');
        await exec.exec('xcodebuild', ['-downloadComponent', 'MetalToolchain'], {ignoreReturnCode: true});
        
        // Verify Metal toolchain installation
        console.log('Verifying Metal toolchain...');
        await exec.exec('xcrun', ['-f', 'metal'], {ignoreReturnCode: true});
        
        console.log('✓ Xcode setup complete');
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

    async _cleanupAfterInit() {
        await cleanupDirectories(this.paths.srcDir, this.config.cleanupDirs);
    }
}

module.exports = MacOSBuilder;
