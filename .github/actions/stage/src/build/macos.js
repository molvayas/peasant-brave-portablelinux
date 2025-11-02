/**
 * macOS-specific build implementation for Brave Browser
 */

const exec = require('@actions/exec');
const fs = require('fs').promises;
const path = require('path');
const {getPlatformConfig, getBuildPaths, STAGES} = require('../config/constants');
const {cleanupDirectories} = require('../utils/disk');
const {execWithTimeout, calculateBuildTimeout, waitAndSync} = require('../utils/exec');
const {TIMEOUTS} = require('../config/constants');

class MacOSBuilder {
    constructor(braveVersion, arch = 'x64') {
        this.braveVersion = braveVersion;
        this.arch = arch;
        this.platform = 'macos';
        this.config = getPlatformConfig(this.platform);
        this.paths = getBuildPaths(this.platform);
        // jobStartTime will be set by orchestrator after construction
        this.jobStartTime = null;
    }

    /**
     * Initialize the build environment
     */
    async initialize() {
        console.log('=== Initializing macOS Build Environment ===');
        console.log(`Brave version: ${this.braveVersion}`);
        console.log(`Architecture: ${this.arch}`);
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
        console.log('\n=== Stage: npm run build ===');
        
        // Calculate timeout based on time elapsed since job start
        if (!this.jobStartTime) {
            throw new Error('jobStartTime not set! Orchestrator must set this before calling runBuild()');
        }
        
        const timing = calculateBuildTimeout(
            this.jobStartTime,
            TIMEOUTS.MAX_BUILD_TIME,
            TIMEOUTS.MIN_BUILD_TIME
        );
        
        console.log(`Time elapsed in job: ${timing.elapsedHours} hours`);
        console.log(`Remaining time calculated: ${timing.remainingHours} hours`);
        console.log(`Final timeout: ${timing.timeoutMinutes} minutes (${timing.remainingHours} hours)`);
        
        console.log('Running npm run build (component build)...');
        
        // Use gtimeout on macOS (from coreutils)
        const buildCode = await execWithTimeout('npm', ['run', 'build'], {
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
            
            // Wait for processes to finish cleanup (longer on macOS)
            await waitAndSync(30000); // 30 seconds
            await waitAndSync(TIMEOUTS.SYNC_WAIT);
            
            return {success: false, timedOut: true};
        } else {
            console.log(`✗ npm run build failed with code ${buildCode}`);
            return {success: false, timedOut: false};
        }
    }

    /**
     * Package the built browser
     */
    async package() {
        console.log('\n=== Stage: Package ===');
        console.log('Packaging built browser for macOS...');
        
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
        
        // Use gtar (GNU tar) with compression
        await exec.exec('gtar', [
            'caf', packagePath,
            '-H', 'posix',
            '--atime-preserve',
            '-C', this.paths.srcDir,
            'out'
        ], {
            ignoreReturnCode: true,
            env: {
                ...process.env,
                LC_ALL: 'C'  // Use C locale to avoid "Illegal byte sequence" errors on macOS
            }
        });
        
        console.log('✓ Package created successfully');
        
        return {
            packagePath,
            packageName
        };
    }

    /**
     * Read current build stage from marker file
     */
    async getCurrentStage() {
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
        
        // Select appropriate Xcode version (26.0 preferred for Metal toolchain)
        const xcodeVersions = [
            '/Applications/Xcode_26.0.app',
            '/Applications/Xcode_16.3.app',
            '/Applications/Xcode_16.2.app',
            '/Applications/Xcode_16.1.app'
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
            console.log('⚠️ No preferred Xcode version found, using default');
            await exec.exec('ls', ['-la', '/Applications/'], {ignoreReturnCode: true});
        }
        
        // Show current Xcode configuration
        console.log('\nCurrent Xcode configuration:');
        await exec.exec('xcode-select', ['--print-path'], {ignoreReturnCode: true});
        await exec.exec('xcodebuild', ['-version'], {ignoreReturnCode: true});
        
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
