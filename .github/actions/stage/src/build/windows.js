/**
 * Windows-specific build implementation for Brave Browser
 */

const exec = require('@actions/exec');
const core = require('@actions/core');
const fs = require('fs').promises;
const path = require('path');
const child_process = require('child_process');
const {getPlatformConfig, getBuildPaths, STAGES} = require('../config/constants');
const {TIMEOUTS} = require('../config/constants');

class WindowsBuilder {
    constructor(braveVersion, arch = 'x64') {
        this.braveVersion = braveVersion;
        this.arch = arch;
        this.platform = 'windows';
        this.config = getPlatformConfig(this.platform);
        this.paths = getBuildPaths(this.platform);
        // jobStartTime will be set by orchestrator after construction
        this.jobStartTime = null;
    }

    /**
     * Initialize the build environment
     */
    async initialize() {
        console.log('=== Initializing Windows Build Environment ===');
        console.log(`Brave version: ${this.braveVersion}`);
        console.log(`Architecture: ${this.arch}`);
        console.log(`Work directory: ${this.paths.workDir}`);
        
        // Set Windows-specific environment variables
        await this._setupEnvironment();
        
        // Install depot_tools dependencies
        await this._installDepotToolsDeps();
        
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
        console.log('Running npm run init with --no-history (no timeout)...');
        
        const initCode = await exec.exec('npm', ['run', 'init', '--', '--no-history'], {
            cwd: this.paths.braveDir,
            ignoreReturnCode: true
        });
        
        if (initCode !== 0) {
            console.log(`✗ npm run init failed with code ${initCode}`);
            return false;
        }
        
        console.log('✓ npm run init completed successfully');
        
        // Windows doesn't use install-build-deps.sh
        // Build tools are auto-detected
        
        // Clean up unnecessary directories
        await this._cleanupAfterInit();
        
        return true;
    }

    /**
     * Run npm run build stage with Windows-specific timeout handling
     */
    async runBuild() {
        console.log('\n=== Stage: npm run build ===');
        
        // Calculate timeout based on time elapsed since job start
        if (!this.jobStartTime) {
            throw new Error('jobStartTime not set! Orchestrator must set this before calling runBuild()');
        }
        
        const elapsedTime = Date.now() - this.jobStartTime;
        let remainingTime = TIMEOUTS.MAX_BUILD_TIME - elapsedTime;
        // remainingTime = 11*60*1000
        
        console.log(`Time elapsed in job: ${(elapsedTime / 3600000).toFixed(2)} hours`);
        console.log(`Remaining time calculated: ${(remainingTime / 3600000).toFixed(2)} hours`);
        
        // Apply timeout rules:
        // 1. If remaining time < 0, set to 15 minutes
        // 2. Minimum timeout is 20 minutes
        const MIN_TIMEOUT = 10 * 60 * 1000; // 20 minutes
        const FALLBACK_TIMEOUT = 15 * 60 * 1000; // 15 minutes
        
        if (remainingTime <= 0) {
            console.log('⚠️ Calculated time is negative, setting to 15 minutes');
            remainingTime = FALLBACK_TIMEOUT;
        } else if (remainingTime < MIN_TIMEOUT) {
            console.log('⚠️ Calculated time is less than minimum, setting to 20 minutes');
            remainingTime = MIN_TIMEOUT;
        }
        
        console.log(`Final timeout: ${(remainingTime / 60000).toFixed(0)} minutes`);
        console.log('Running npm run build (component build)...');
        
        const buildCode = await this._execWithTimeout('npm', ['run', 'build'], {
            cwd: this.paths.braveDir,
            timeout: remainingTime
        });
        
        if (buildCode === 0) {
            console.log('✓ npm run build completed successfully');
            return {success: true, timedOut: false};
        } else if (buildCode === 999) {
            // Windows timeout code
            console.log('⏱️ npm run build timed out - will resume in next stage');
            
            // Critical: Wait for Windows to release all file handles and locks
            // Chromium builds have hundreds of open files and processes
            // Windows needs more time than Linux due to how it handles file locks
            console.log('Waiting 60 seconds for all file handles to close and locks to release...');
            await new Promise(r => setTimeout(r, 60000));
            
            // Additional safety wait for filesystem to stabilize
            console.log('Waiting additional 15 seconds for filesystem to stabilize...');
            await new Promise(r => setTimeout(r, 15000));
            
            console.log('✓ Cleanup complete, build state should be preserved for resumption');
            
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
        console.log('Packaging built browser for Windows...');
        
        const outDir = path.join(this.paths.srcDir, 'out');
        
        try {
            await fs.access(outDir);
            console.log(`Found out directory at ${outDir}`);
        } catch (e) {
            throw new Error(`Out directory not found at ${outDir}`);
        }
        
        // Create zip of entire out directory
        const packageName = `brave-browser-${this.braveVersion}-${this.platform}-${this.arch}.${this.config.packageFormat}`;
        const packagePath = path.join(this.paths.workDir, packageName);
        
        console.log(`Creating archive: ${packageName}`);
        console.log('Compressing out directory with 7z...');
        
        // Use 7z with moderate compression
        await exec.exec('7z', [
            'a', '-tzip',
            packagePath,
            outDir,
            '-mx=5'
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

    async _setupEnvironment() {
        console.log('Setting Windows-specific environment variables...');
        core.exportVariable('DEPOT_TOOLS_WIN_TOOLCHAIN', '0');
        core.exportVariable('PYTHONUNBUFFERED', '1');
        core.exportVariable('GSUTIL_ENABLE_LUCI_AUTH', '0');
        console.log('✓ Environment configured');
    }

    async _installDepotToolsDeps() {
        console.log('Installing depot_tools dependencies...');
        await exec.exec('python', ['-m', 'pip', 'install', 'httplib2==0.22.0'], {
            ignoreReturnCode: true
        });
        console.log('✓ depot_tools dependencies installed');
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
        // Windows cleanup is minimal - just remove obvious directories
        // Don't use wildcard cleanup on Windows due to path issues
        console.log('Cleaning up unnecessary directories...');
        
        for (const dir of this.config.cleanupDirs) {
            const fullPath = path.join(this.paths.srcDir, dir);
            try {
                await exec.exec('cmd', ['/c', 'rmdir', '/s', '/q', fullPath], {ignoreReturnCode: true});
                console.log(`  Removed: ${dir}`);
            } catch (e) {
                // Directory doesn't exist or already removed
            }
        }
        
        console.log('✓ Cleanup complete');
    }

    /**
     * Windows-specific timeout implementation using taskkill
     * Gracefully terminates npm run build and waits for cleanup
     * @param {string} command - Command to run
     * @param {string[]} args - Command arguments
     * @param {object} options - Options including cwd and timeout in milliseconds
     * @returns {Promise<number>} Exit code (999 if timeout)
     */
    async _execWithTimeout(command, args, options = {}) {
        const {cwd, timeout} = options;
        
        return new Promise((resolve) => {
            console.log(`Running: ${command} ${args.join(' ')}`);
            console.log(`Timeout: ${(timeout / 60000).toFixed(0)} minutes (${(timeout / 3600000).toFixed(2)} hours)`);
            
            const child = child_process.spawn(command, args, {
                cwd: cwd,
                stdio: 'inherit',
                shell: true,
                windowsHide: false
            });
            
            let timedOut = false;
            
            const timer = setTimeout(async () => {
                console.log(`\n⏱️ Timeout reached after ${(timeout / 60000).toFixed(0)} minutes`);
                console.log('Gracefully terminating build process...');
                timedOut = true;
                
                // Send graceful termination signal to the entire process tree
                // This allows ninja to save build state properly
                try {
                    console.log(`Sending SIGTERM to process tree (PID ${child.pid})...`);
                    child_process.execSync(`taskkill /T /PID ${child.pid}`, {stdio: 'inherit'});
                    console.log('Termination signal sent successfully');
                } catch (e) {
                    console.log('Process may have already exited');
                }
                
                // Wait for build system to clean up and save state
                console.log('Waiting 60 seconds for build system cleanup...');
                await new Promise(r => setTimeout(r, 60000));
                console.log('✓ Cleanup period complete');
                
                // Resolve with timeout code
                resolve(999);
            }, timeout);
            
            child.on('exit', (code) => {
                clearTimeout(timer);
                
                if (timedOut) {
                    // Already handled in timeout callback
                    return;
                }
                
                console.log(`Process exited with code: ${code}`);
                resolve(code || 0);
            });
            
            child.on('error', (err) => {
                clearTimeout(timer);
                console.error(`Process error: ${err.message}`);
                resolve(1);
            });
        });
    }
}

module.exports = WindowsBuilder;
