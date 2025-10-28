/**
 * Linux-specific build implementation for Brave Browser
 */

const exec = require('@actions/exec');
const core = require('@actions/core');
const fs = require('fs').promises;
const path = require('path');
const {getPlatformConfig, getBuildPaths, STAGES} = require('../config/constants');
const {cleanupDirectories} = require('../utils/disk');
const {execWithTimeout, calculateBuildTimeout, waitAndSync} = require('../utils/exec');
const {TIMEOUTS} = require('../config/constants');

class LinuxBuilder {
    constructor(braveVersion, arch = 'x64') {
        this.braveVersion = braveVersion;
        this.arch = arch;
        this.platform = 'linux';
        this.config = getPlatformConfig(this.platform);
        this.paths = getBuildPaths(this.platform);
        // jobStartTime will be set by orchestrator after construction
        this.jobStartTime = null;
    }

    /**
     * Initialize the build environment
     */
    async initialize() {
        console.log('=== Initializing Linux Build Environment ===');
        console.log(`Brave version: ${this.braveVersion}`);
        console.log(`Architecture: ${this.arch}`);
        console.log(`Work directory: ${this.paths.workDir}`);
        
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
        console.log('\n=== Stage: npm run build ===');
        
        // Calculate timeout based on time elapsed since job start
        // This ensures we account for time spent on init, downloads, etc.
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
        
        const buildCode = await execWithTimeout('npm', ['run', 'build'], {
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
            await waitAndSync(TIMEOUTS.CLEANUP_WAIT);
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
        console.log('Packaging built browser...');
        
        const braveExe = path.join(this.paths.outDir, this.config.executable);
        
        try {
            await fs.access(braveExe);
            console.log(`Found brave executable at ${braveExe}`);
        } catch (e) {
            throw new Error(`Brave executable not found at ${braveExe}`);
        }
        
        // Create tarball
        const packageName = `brave-browser-${this.braveVersion}-${this.platform}-${this.arch}.${this.config.packageFormat}`;
        const packagePath = path.join(this.paths.workDir, packageName);
        
        console.log(`Creating package: ${packageName}`);
        
        await exec.exec('tar', [
            '-cJf', packagePath,
            '-C', this.paths.outDir,
            'brave', 'chrome_crashpad_handler',
            'libEGL.so', 'libGLESv2.so', 'libvk_swiftshader.so',
            'libvulkan.so.1', 'locales', 'resources.pak',
            'chrome_100_percent.pak', 'chrome_200_percent.pak',
            'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin'
        ], {ignoreReturnCode: true});
        
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

