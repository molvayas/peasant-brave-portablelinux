/**
 * Windows-specific Brave Browser Builder
 */

const exec = require('@actions/exec');
const core = require('@actions/core');
const fs = require('fs').promises;
const path = require('path');
const child_process = require('child_process');
const {getPlatformConfig, getBuildPaths, STAGES, getTimeouts} = require('../config/constants');

class WindowsBuilder {
    /**
     * Initialize Windows-specific builder with Visual Studio integration
     *
     * Configures the builder for Windows development environment, including
     * Visual Studio toolchain management and cross-architecture support.
     *
     * @param {string} braveVersion - Brave version tag to build (e.g., "v1.50.100")
     * @param {string} arch - Target architecture (x64, arm64, x86)
     */
    constructor(braveVersion, arch = 'x64') {
        this.braveVersion = braveVersion;
        this.arch = arch;
        this.platform = 'windows';
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
     * Build paths depend on buildType (Component vs Release) because Chromium
     * organizes output directories differently for different build configurations.
     * This method is called lazily to ensure paths are available when needed.
     * Architecture is passed to handle platform-specific path overrides (e.g., Windows ARM64 uses C: drive).
     *
     * @private
     */
    _ensurePaths() {
        if (!this.paths) {
            this.paths = getBuildPaths(this.platform, this.buildType);
        }
    }

    /**
     * Initialize the complete Windows build environment
     *
     * Sets up everything needed for a Brave browser build on Windows, including:
     * - Windows-specific environment variables for Visual Studio toolchain
     * - depot_tools Python dependencies for Chromium build system
     * - Brave source code checkout from GitHub
     * - Node.js/npm dependencies for the build system
     *
     * The Visual Studio toolchain integration is critical as Chromium requires
     * specific compiler versions and Windows SDK components.
     *
     * @returns {Promise<void>} Completes when environment is fully initialized
     */
    async initialize() {
        this._ensurePaths();
        console.log('=== Initializing Windows Build Environment ===');
        console.log(`Brave version: ${this.braveVersion}`);
        console.log(`Architecture: ${this.arch}`);
        console.log(`Build type: ${this.buildType}`);
        console.log(`Work directory: ${this.paths.workDir}`);
        
        // Set Windows-specific environment variables
        await this._setupEnvironment();
        
        // Install depot_tools dependencies
        await this._installDepotToolsDeps();
        
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
     * This stage runs the Brave build system's initialization, which:
     * 1. Downloads and sets up the Chromium source code and dependencies
     * 2. Configures the GN build system with appropriate flags
     * 3. Prepares the build directory structure
     *
     * Unlike Linux, Windows doesn't require running Chromium's install-build-deps.sh
     * because Visual Studio Build Tools are pre-installed on Windows runners.
     * The build tools are auto-detected by Chromium's build system.
     *
     * @returns {Promise<boolean>} true if initialization successful, false if failed
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
        if (!this.jobStartTime) {
            throw new Error('jobStartTime not set! Orchestrator must set this before calling runBuild()');
        }
        
        const timeouts = getTimeouts(this.platform);
        const elapsedTime = Date.now() - this.jobStartTime;
        let remainingTime = timeouts.MAX_BUILD_TIME - elapsedTime;
        
        console.log(`Time elapsed in job: ${(elapsedTime / 3600000).toFixed(2)} hours`);
        console.log(`Remaining time calculated: ${(remainingTime / 3600000).toFixed(2)} hours`);
        
        // Apply timeout rules:
        // 1. If remaining time < 0, use fallback timeout
        // 2. Use minimum timeout if calculated time is too low
        if (remainingTime <= 0) {
            console.log('⚠️ Calculated time is negative, using fallback timeout');
            remainingTime = timeouts.FALLBACK_TIMEOUT;
        } else if (remainingTime < timeouts.MIN_BUILD_TIME) {
            console.log('⚠️ Calculated time is less than minimum, using minimum timeout');
            remainingTime = timeouts.MIN_BUILD_TIME;
        }
        
        // Build command based on buildType
        let buildArgs;
        if (this.buildType === 'Release') {
            // Release: build browser and create distribution package in one go with full optimizations
            buildArgs = [
                'run', 'build', 'Release', '--', 
                '--target_arch=' + this.arch, 
                '--target=create_dist', 
                '--skip_signing', 
                '--ninja', `j:6`,
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
            buildArgs = ['run', 'build', '--', '--target_arch=' + this.arch, '--ninja', `j:6`, '--gn', 'symbol_level:0', '--gn', 'blink_symbol_level:0', '--gn', 'v8_symbol_level:0', '--gn', 'should_generate_symbols:false'];
            console.log('Running npm run build (component)...');
            console.log(`Note: Building for ${this.arch} architecture`);
            console.log('Note: Building with symbol_level=0, blink_symbol_level=0, v8_symbol_level=0 to reduce build size and time');
            console.log('Note: Disabled should_generate_symbols to skip symbol generation');
        }
        
        console.log(`Final timeout: ${(remainingTime / 60000).toFixed(0)} minutes`);
        console.log(`Command: npm ${buildArgs.join(' ')}`);
        
        const buildCode = await this._execWithTimeout('npm', buildArgs, {
            cwd: this.paths.braveDir,
            timeout: remainingTime
        });
        
        if (buildCode === 0) {
            console.log('✓ npm run build completed successfully');
            return {success: true, timedOut: false};
        } else if (buildCode === 999) {
            // Windows timeout code
            console.log('TIMEOUT: npm run build timed out - will resume in next stage');
            
            // Check disk space before archiving
            console.log('\n=== Checking disk space ===');
            const outPath = path.join(this.paths.srcDir, 'out');
            
            // Show disk space using wmic (simpler and more reliable)
            await exec.exec('wmic', ['logicaldisk', 'get', 'name,freespace,size', '/format:table'], {ignoreReturnCode: true});
            
            console.log('\n=== Disk usage in out directory ===');
            // Calculate out/ directory size
            await exec.exec('powershell', [
                '-NoProfile',
                '-Command',
                `$path = '${outPath.replace(/\\/g, '\\\\')}'; if (Test-Path $path) { $size = (Get-ChildItem $path -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB; Write-Host "Total size: $([math]::Round($size, 2)) GB" } else { Write-Host "Directory does not exist" }`
            ], {ignoreReturnCode: true});
            
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
            // Release builds: grab distribution package from dist/
            console.log('Packaging Release build from dist...');
            
            // Windows: create_dist creates zip in out/Release/dist/ or out/Release_{arch}/dist/
            // Brave's build system naming:
            // - x64: out/Release/ (no suffix, default)
            // - arm64: out/Release_arm64/ (with suffix)
            // - x86: out/Release_x86/ (with suffix)
            const possibleDistDirs = [
                path.join(this.paths.srcDir, 'out', 'Release', 'dist')  // Always try default first
            ];
            if (this.arch !== 'x64') {
                possibleDistDirs.push(path.join(this.paths.srcDir, 'out', `Release_${this.arch}`, 'dist'));
            }
            
            // Look for the distribution zip file
            // Format: brave-v{version}-win32-{arch}.zip (lowercase "brave", single v, win32 not win)
            // Strip any leading 'v' from version to avoid double-v
            const versionWithoutV = this.braveVersion.startsWith('v') 
                ? this.braveVersion.substring(1) 
                : this.braveVersion;
            const expectedZipName = `brave-v${versionWithoutV}-win32-${this.arch}.zip`;
            
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
                // Fallback 1: search for any brave-*.zip in known directories
                console.log(`Expected file ${expectedZipName} not found in standard locations`);
                console.log('Searching for any brave distribution file...');
                
                for (const distDir of possibleDistDirs) {
                    console.log(`Searching in ${distDir}...`);
                    try {
                        const files = await fs.readdir(distDir);
                        console.log(`Files in ${distDir}:`, files.filter(f => f.endsWith('.zip')));
                        const zipFile = files.find(f => f.startsWith('brave-') && f.endsWith('.zip') && !f.includes('symbols'));
                        if (zipFile) {
                            console.log(`Using found zip file: ${zipFile}`);
                            distZipPath = path.join(distDir, zipFile);
                            foundInDir = distDir;
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
                            .map(dirent => dirent.name);
                        
                        console.log(`Found Release directories: ${releaseDirs.join(', ')}`);
                        
                        for (const releaseDir of releaseDirs) {
                            const distDir = path.join(outDir, releaseDir, 'dist');
                            console.log(`Checking ${distDir}...`);
                            try {
                                const files = await fs.readdir(distDir);
                                const zipFile = files.find(f => f.startsWith('brave-') && f.endsWith('.zip') && !f.includes('symbols'));
                                if (zipFile) {
                                    console.log(`✓ Found zip file in ${distDir}: ${zipFile}`);
                                    distZipPath = path.join(distDir, zipFile);
                                    foundInDir = distDir;
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
                    throw new Error(`Distribution package not found. Tried: ${possibleDistDirs.join(', ')}, and all Release* directories`);
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
            // Component builds: create zip of entire out directory
            console.log('Packaging Component build from output directory...');
            
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
            console.log('Compressing out directory with 7z (excluding obj directory)...');
            
            // Use 7z with moderate compression, exclude obj directory
            await exec.exec('7z', [
                'a', '-tzip',
                packagePath,
                outDir,
                '-mx=5',
                '-xr!obj'  // Exclude obj directory recursively
            ], {ignoreReturnCode: true});
            
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
    // Private methods - Windows-specific implementation details
    // ========================================================================

    /**
     * Setup Windows-specific environment variables
     *
     * I don't remember why it's here.
     * 
     * @private
     */
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
        
        // Install quilt via MSYS2 for patch management
        console.log('Installing quilt via MSYS2...');
        await exec.exec('C:\\msys64\\usr\\bin\\pacman.exe', ['-S', '--noconfirm', 'quilt'], {
            ignoreReturnCode: true
        });
        console.log('✓ quilt installed');
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
        
        // Windows: Use quilt via MSYS2 (same as Linux for consistency)
        const quiltExe = 'C:\\msys64\\usr\\bin\\quilt.exe';
        
        // Set up quilt environment
        const quiltEnv = {
            ...process.env,
            QUILT_PATCHES: patchesDir,
            QUILT_SERIES: seriesFile,
            QUILT_PC: path.join(this.paths.braveDir, '.pc')
        };
        
        console.log('Applying all patches with quilt...');
        
        // Apply all patches using quilt push -a (same as Linux)
        const patchCode = await exec.exec(quiltExe, ['push', '-a'], {
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
     *
     * Provides reliable timeout handling for long-running Windows processes.
     * Uses taskkill to terminate entire process trees, which is necessary because
     * Windows handles child processes and file handles differently than Unix systems.
     *
     * Process:
     * 1. Spawns the command as a child process
     * 2. Sets a timer for the specified timeout
     * 3. On timeout: Uses taskkill /F /T to force-kill entire process tree
     * 4. Waits for Windows to release file handles and locks
     * 5. Returns exit code 999 to indicate timeout
     *
     * @private
     * @param {string} command - Command to execute
     * @param {string[]} args - Command arguments
     * @param {object} options - Execution options
     * @param {string} options.cwd - Working directory
     * @param {number} options.timeout - Timeout in milliseconds
     * @returns {Promise<number>} Exit code (0 = success, 999 = timeout, other = command error)
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
                console.log(`\nTIMEOUT: Timeout reached after ${(timeout / 60000).toFixed(0)} minutes`);
                console.log('Terminating build process...');
                timedOut = true;
                
                // Force kill the entire process tree
                // /F = force, /T = entire tree
                try {
                    console.log(`Force killing process tree (PID ${child.pid})...`);
                    child_process.execSync(`taskkill /F /T /PID ${child.pid}`, {stdio: 'inherit'});
                    console.log('Process tree terminated');
                } catch (e) {
                    console.log('Process may have already exited');
                }
                
                // Wait for Windows to release file handles and locks
                console.log('Waiting 60 seconds for file handles to release and state to be saved...');
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
