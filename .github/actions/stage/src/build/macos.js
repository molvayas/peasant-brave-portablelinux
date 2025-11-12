/**
 * macOS-specific Brave Browser Builder
 */

const exec = require('@actions/exec');
const fs = require('fs').promises;
const path = require('path');
const {getPlatformConfig, getBuildPaths, STAGES, getTimeouts} = require('../config/constants');
const {cleanupDirectories} = require('../utils/disk');
const {execWithTimeout, calculateBuildTimeout, waitAndSync} = require('../utils/exec');

class MacOSBuilder {
    /**
     * Initialize macOS-specific builder with Apple ecosystem integration
     *
     * Configures the builder for macOS development environment, including
     * Xcode toolchain management and ARM64 code signing preparation.
     *
     * @param {string} braveVersion - Brave version tag to build (e.g., "v1.50.100")
     * @param {string} arch - Target architecture (x64 for Intel, arm64 for Apple Silicon)
     */
    constructor(braveVersion, arch = 'x64') {
        this.braveVersion = braveVersion;
        this.arch = arch;
        this.platform = 'macos';
        this.config = getPlatformConfig(this.platform);

        // These properties are set by the orchestrator after construction
        this.buildType = 'Component';    // Component (dev) or Release (production)
        this.jobStartTime = null;        // For timeout calculations
        this.envConfig = '';             // .env file contents
        this.paths = null;               // Build paths (set after buildType is known)
    }
    
    /**
     * Ensure build paths are initialized based on current buildType
     *
     * Build paths depend on buildType (Component vs Release) because it
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
     * Initialize the complete macOS build environment
     *
     * Sets up everything needed for a Brave browser build on macOS, including:
     * - Homebrew dependencies (coreutils for gtimeout)
     * - Xcode toolchain selection and Metal graphics support
     * - Brave source code checkout from GitHub
     * - Node.js/npm dependencies for the build system
     *
     * @returns {Promise<void>} Completes when environment is fully initialized
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
        
        // Apply custom patches
        await this._applyPatches();
        
        // Install npm dependencies
        await this._installNpmDependencies();
    }

    /**
     * Execute the npm run init stage
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
        
        // macOS doesn't use install-build-deps.sh
        // Chromium build deps are already available on macOS runner
        
        // Clean up unnecessary directories
        await this._cleanupAfterInit();
        
        return true;
    }

    /**
     * Execute the npm run build stage
     *
     * Uses gtimeout (GNU timeout) instead of regular timeout for compatibility
     * with macOS. Implements intelligent timeout management to work within
     * GitHub Actions' 6-hour limit.
     *
     * @returns {Promise<{success: boolean, timedOut: boolean}>}
     *         success: true if build completed successfully
     *         timedOut: true if build timed out (can be resumed)
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
            // Release: build browser and create distribution package in one go with full optimizations
            buildArgs = [
                'run', 'build', 'Release', '--', 
                '--target_arch=' + this.arch, 
                '--target=create_dist', 
                '--skip_signing', 
                '--ninja', `j:5`,
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
            console.log('Note: Symbol generation disabled for maximum performance');
        } else {
            // Component: just build
            buildArgs = ['run', 'build', '--', '--target_arch=' + this.arch, '--ninja', `j:5`, '--gn', 'symbol_level:0', '--gn', 'blink_symbol_level:0', '--gn', 'v8_symbol_level:0', '--gn', 'should_generate_symbols:false'];
            console.log('Running npm run build (component)...');
            console.log(`Note: Building for ${this.arch} architecture`);
            console.log('Note: Building with symbol_level=0, blink_symbol_level=0, v8_symbol_level=0 to reduce build size and time');
            console.log('Note: Disabled should_generate_symbols to skip symbol generation');
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
            console.log('TIMEOUT: npm run build timed out - will resume in next stage');
            
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
     * Package the compiled browser into distributable artifacts
     *
     * Handles different packaging strategies based on build type:
     *
     * Release builds: Locate and copy the distribution ZIP/DMG created by Brave's
     *                 build system, with special handling for ARM64 code signing
     *
     * Component builds: Create compressed tarball of entire output directory
     *                   for development/testing purposes
     *
     * ARM64 builds receive special code signing treatment to ensure compatibility
     * with Apple's Gatekeeper and security requirements.
     *
     * @returns {Promise<{packagePath: string, packageName: string}>}
     *         packagePath: Absolute path to the created package file
     *         packageName: Standardized package filename
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
                            console.log('✓ Package copied successfully (original)');
                            
                            // Sign the .app bundle for ARM64 builds (only for .zip files)
                            if (this.arch === 'arm64' && ext === 'zip') {
                                console.log('\n=== Code Signing ARM64 Build ===');
                                // Create signed version with "-signed" suffix
                                const signedPackageName = packageName.replace('.zip', '-signed.zip');
                                const signedPackagePath = path.join(this.paths.workDir, signedPackageName);
                                
                                // Copy original to signed path, then sign it
                                await fs.copyFile(packagePath, signedPackagePath);
                                console.log(`✓ Created signed copy: ${signedPackageName}`);
                                
                                // Sign the copied file (this will modify it in place)
                                await this._signAppBundle(signedPackagePath);
                                
                                console.log(`✓ Original package preserved: ${packageName}`);
                                console.log(`✓ Signed package created: ${signedPackageName}`);
                                
                                return { packagePath: signedPackagePath, packageName: signedPackageName };
                            }
                            
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
                                    console.log('✓ Package copied successfully (original)');
                                    
                                    // Sign the .app bundle for ARM64 builds (only for .zip files)
                                    if (this.arch === 'arm64' && ext === 'zip') {
                                        console.log('\n=== Code Signing ARM64 Build ===');
                                        // Create signed version with "-signed" suffix
                                        const signedPackageName = packageName.replace('.zip', '-signed.zip');
                                        const signedPackagePath = path.join(this.paths.workDir, signedPackageName);
                                        
                                        // Copy original to signed path, then sign it
                                        await fs.copyFile(packagePath, signedPackagePath);
                                        console.log(`✓ Created signed copy: ${signedPackageName}`);
                                        
                                        // Sign the copied file (this will modify it in place)
                                        await this._signAppBundle(signedPackagePath);
                                        
                                        console.log(`✓ Original package preserved: ${packageName}`);
                                        console.log(`✓ Signed package created: ${signedPackageName}`);
                                        
                                        return { packagePath: signedPackagePath, packageName: signedPackageName };
                                    }
                                    
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
            console.log('✓ Package copied successfully (original)');
            
            // Sign the .app bundle for ARM64 builds
            if (this.arch === 'arm64') {
                console.log('\n=== Code Signing ARM64 Build ===');
                // Create signed version with "-signed" suffix
                const signedPackageName = packageName.replace('.zip', '-signed.zip');
                const signedPackagePath = path.join(this.paths.workDir, signedPackageName);
                
                // Copy original to signed path, then sign it
                await fs.copyFile(packagePath, signedPackagePath);
                console.log(`✓ Created signed copy: ${signedPackageName}`);
                
                // Sign the copied file (this will modify it in place)
                await this._signAppBundle(signedPackagePath);
                
                console.log(`✓ Original package preserved: ${packageName}`);
                console.log(`✓ Signed package created: ${signedPackageName}`);
                
                return {
                    packagePath: signedPackagePath,
                    packageName: signedPackageName
                };
            }
            
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
    // Private methods - macOS-specific implementation details
    // ========================================================================

    /**
     * Install macOS-specific build dependencies via Homebrew
     *
     * macOS requires GNU coreutils for the gtimeout command used in timeout
     * handling. Unlike Linux which has native timeout, macOS needs this
     * additional dependency for reliable build process management.
     *
     * @private
     */
    async _installBrewDependencies() {
        console.log('Installing build dependencies via Homebrew...');
        console.log('Installing: coreutils (for gtimeout), quilt (for patches)');
        
        await exec.exec('brew', ['install', 'coreutils', 'quilt'], {ignoreReturnCode: true});
        
        console.log('✓ Homebrew dependencies installed');
    }

    /**
     * Setup Xcode development environment and Metal toolchain
     *
     * Configures the appropriate Xcode version and installs the Metal graphics
     * toolchain required for Chromium builds. Chromium requires specific Xcode
     * versions for compatibility, and Metal is needed for GPU acceleration.
     *
     * Tries multiple Xcode versions in order of preference, falling back
     * gracefully if preferred versions aren't available.
     *
     * @private
     */
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
                console.log(`✓ Using ${xcodePath}`);
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
        
        console.log(`Patches directory: ${patchesDir}`);
        console.log(`Series file: ${seriesFile}`);
        console.log(`Brave directory: ${this.paths.braveDir}`);
        
        // macOS: Use quilt (installed via Homebrew, same as Linux for consistency)
        // Set up quilt environment
        const quiltEnv = {
            ...process.env,
            QUILT_PATCHES: patchesDir,
            QUILT_SERIES: seriesFile,
            QUILT_PC: path.join(this.paths.braveDir, '.pc')
        };
        
        console.log('Applying all patches with quilt...');
        
        // Apply all patches using quilt push -a (same as Linux)
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

    async _cleanupAfterInit() {
        await cleanupDirectories(this.paths.srcDir, this.config.cleanupDirs);
    }

    /**
     * Sign the .app bundle inside a zip file for ARM64 compatibility
     *
     * Apple Silicon (ARM64) builds require code signing to run on macOS.
     * This method extracts the distribution ZIP, finds the .app bundle,
     * applies ad-hoc code signing, and re-packages everything.
     *
     * Process:
     * 1. Extract the ZIP file to temporary directory
     * 2. Locate the .app bundle within extracted contents
     * 3. Apply ad-hoc code signing with codesign --force --deep -s -
     * 4. Verify the signature
     * 5. Re-package as ZIP with the signed .app bundle
     *
     * Ad-hoc signing allows the app to run on the same machine without
     * requiring a full Apple Developer Program certificate.
     *
     * @private
     * @param {string} zipPath - Path to the zip file containing the .app bundle
     * @returns {Promise<string>} Path to the signed zip file (same as input, overwritten)
     */
    async _signAppBundle(zipPath) {
        const tempDir = path.join(this.paths.workDir, 'sign-temp');
        const extractDir = path.join(tempDir, 'extracted');
        
        try {
            // Create temp directory
            await fs.mkdir(extractDir, { recursive: true });
            console.log(`Extracting zip to ${extractDir}...`);
            
            // Extract zip file
            await exec.exec('unzip', ['-q', zipPath, '-d', extractDir]);
            console.log('✓ Zip extracted');
            
            // Find the .app bundle (should be in the root of the extracted zip)
            const extractedFiles = await fs.readdir(extractDir);
            const appBundle = extractedFiles.find(f => f.endsWith('.app'));
            
            if (!appBundle) {
                throw new Error(`No .app bundle found in extracted zip. Files found: ${extractedFiles.join(', ')}`);
            }
            
            const appPath = path.join(extractDir, appBundle);
            console.log(`Found .app bundle: ${appBundle}`);
            console.log(`Signing with ad-hoc signature (codesign --force --deep -s -)...`);
            
            // Sign the .app bundle with ad-hoc signing
            // -s - means ad-hoc signing (no identity needed)
            // --force forces re-signing even if already signed
            // --deep signs nested code (frameworks, helpers, etc.)
            await exec.exec('codesign', [
                '--force',
                '--deep',
                '-s', '-',
                appPath
            ]);
            
            console.log('✓ .app bundle signed successfully');
            
            // Verify the signature
            console.log('Verifying signature...');
            await exec.exec('codesign', ['--verify', '--verbose', appPath]);
            console.log('✓ Signature verified');
            
            // Remove old zip and create new one
            console.log('Re-zipping signed .app bundle...');
            await fs.unlink(zipPath);
            
            // Create new zip with the signed .app bundle
            // Use -r for recursive, -y for storing symlinks as-is, -q for quiet
            await exec.exec('zip', [
                '-r',
                '-y',
                '-q',
                zipPath,
                appBundle
            ], {
                cwd: extractDir
            });
            
            console.log('✓ Re-zipped with signed .app bundle');
            console.log(`Signed package: ${zipPath}`);
            
            return zipPath;
            
        } catch (error) {
            console.error('Error signing .app bundle:', error);
            throw error;
        } finally {
            // Clean up temp directory
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.warn(`Warning: Failed to clean up temp directory ${tempDir}: ${cleanupError.message}`);
            }
        }
    }
}

module.exports = MacOSBuilder;
