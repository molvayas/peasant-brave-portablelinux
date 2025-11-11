/**
 * Build Orchestrator - Central coordinator for multi-stage Brave browser builds
 *
 * This orchestrator manages the lifecycle of Brave browser builds. It implements a
 * checkpoint/resume system using GitHub Artifacts to persist build state across
 * multiple workflow runs.
 */

const core = require('@actions/core');
const io = require('@actions/io');
const {DefaultArtifactClient} = require('@actions/artifact');
const fs = require('fs').promises;
const path = require('path');

const {createBuilder} = require('./build/factory');
const {createMultiVolumeArchive, extractMultiVolumeArchive} = require('./archive/multi-volume');
const {createWindowsCheckpoint, extractWindowsCheckpoint} = require('./archive/windows-archive');
const {waitAndSync} = require('./utils/exec');
const { DiskAnalyzer } = require('./utils/disk-analysis');
const { setupArtifactDebugFilter } = require('./utils/log');
const {STAGES, ARTIFACTS, ARCHIVE, TIMEOUTS} = require('./config/constants');

class BuildOrchestrator {
    /**
     * Initialize the build orchestrator with platform-specific configuration
     *
     * @param {Object} options - Build configuration options
     * @param {boolean} options.finished - Whether build already completed (skip execution)
     * @param {boolean} options.fromArtifact - Whether to resume from checkpoint artifact
     * @param {string} options.braveVersion - Brave version tag to build
     * @param {string} options.platform - Target platform (linux, macos, windows)
     * @param {string} options.arch - Target architecture (x64, arm64, x86)
     * @param {string} options.buildType - Build type (Component or Release)
     * @param {string} options.envConfig - Contents for .env configuration file
     */
    constructor(options) {
        // Core build state and configuration
        this.finished = options.finished;
        this.fromArtifact = options.fromArtifact;
        this.braveVersion = options.braveVersion;
        this.platform = options.platform || 'linux';
        this.arch = options.arch || 'x64';
        this.buildType = options.buildType || 'Component';
        this.envConfig = options.envConfig || '';

        // Track job start time for intelligent timeout calculations
        // Used to determine remaining time in GitHub Actions execution context
        this.jobStartTime = Date.now();

        // Initialize GitHub Artifacts client for checkpoint/resume functionality
        this.artifact = new DefaultArtifactClient();

        // Create platform-specific builder using factory pattern
        this.builder = createBuilder(this.platform, this.braveVersion, this.arch);

        // Propagate configuration to the builder instance
        this.builder.jobStartTime = this.jobStartTime;
        this.builder.buildType = this.buildType;
        this.builder.envConfig = this.envConfig;

        // Setup logging filters to reduce artifact operation noise
        setupArtifactDebugFilter();
    }

    /**
     * Main orchestration method - executes the complete build workflow
     *
     * This method implements the core build logic with intelligent error handling and
     * checkpoint creation. The flow follows this pattern:
     *
     * 1. Early exit if build already completed (finished=true)
     * 2. Environment setup (fresh or from checkpoint)
     * 3. Stage execution (init → build → package)
     * 4. Success: package final artifact and cleanup checkpoints
     * 5. Failure/Timeout: create checkpoint for next run
     * 6. Error handling: attempt checkpoint creation even on failures
     *
     * @returns {Promise<void>} Resolves when build orchestration completes
     */
    async run() {
        // ============================================================================
        // SIGNAL HANDLING
        // ============================================================================

        // Handle graceful shutdown on SIGINT (Ctrl+C) to allow cleanup
        process.on('SIGINT', function() {
            console.log('\nReceived SIGINT - allowing graceful shutdown...');
        });

        // ============================================================================
        // BUILD CONFIGURATION LOGGING
        // ============================================================================

        console.log('=== Brave Browser Build Orchestrator ===');
        console.log(`Platform: ${this.platform}`);
        console.log(`Architecture: ${this.arch}`);
        console.log(`Brave Version: ${this.braveVersion}`);
        console.log(`Build Type: ${this.buildType}`);
        console.log(`Finished: ${this.finished}`);
        console.log(`From Artifact: ${this.fromArtifact}`);
        console.log(`.env Config: ${this.envConfig ? 'Provided (will be created)' : 'Not provided'}`);
        console.log('========================================\n');

        // ============================================================================
        // EARLY EXIT FOR COMPLETED BUILDS
        // ============================================================================

        // If build finished in a previous stage, skip execution entirely
        if (this.finished) {
            console.log('Build already finished in previous stage - skipping execution');
            core.setOutput('finished', true);
            return;
        }

        let buildSuccess = false;

        try {
            // ============================================================================
            // PHASE 1: ENVIRONMENT SETUP
            // ============================================================================

            console.log('🚀 Phase 1: Setting up build environment...');
            await this._setupEnvironment();

            // ============================================================================
            // PHASE 2: BUILD STAGE EXECUTION
            // ============================================================================

            console.log('🔨 Phase 2: Executing build stages...');
            buildSuccess = await this._runBuildStages();

            // ============================================================================
            // PHASE 3: SUCCESS HANDLING
            // ============================================================================

            if (buildSuccess) {
                console.log('✅ Build completed successfully!');

                // Create and upload the final distributable package
                console.log('📦 Creating final package...');
                await this._packageAndUpload();

                // Remove checkpoint artifacts (no longer needed)
                console.log('🧹 Cleaning up checkpoint artifacts...');
                await this._cleanupCheckpointArtifacts();

                // Signal successful completion to GitHub Actions
                core.setOutput('finished', true);
                console.log('🎉 Build orchestration completed successfully');

            } else {
                // ============================================================================
                // PHASE 3: CHECKPOINT CREATION (ON TIMEOUT/FAILURE)
                // ============================================================================

                console.log('⏱️  Build timed out or failed - creating checkpoint for resumption...');
                await this._createCheckpoint();

                // Signal that build needs continuation in next stage
                core.setOutput('finished', false);
                console.log('💾 Checkpoint created - build will resume in next stage');
            }

        } catch (error) {
            // ============================================================================
            // ERROR HANDLING WITH CHECKPOINT CREATION
            // ============================================================================

            console.error(`💥 Build orchestration failed: ${error.message}`);
            console.error('Full error details:', error.stack);

            // Attempt to create a checkpoint even on errors to preserve progress
            console.log('🛟 Attempting to create emergency checkpoint...');
            try {
                await this._createCheckpoint();
                core.setOutput('finished', false);
                console.log('⚠️  Emergency checkpoint created despite error');
            } catch (checkpointError) {
                console.error(`❌ Failed to create emergency checkpoint: ${checkpointError.message}`);
                // Mark the entire GitHub Action as failed
                core.setFailed(`Build failed: ${error.message}`);
            }
        }
    }

    /**
     * Setup or restore the complete build environment
     *
     * This method handles both fresh environment initialization and restoration from
     * checkpoint artifacts. It ensures all necessary directories exist and configures
     * the build environment appropriately for the current platform.
     *
     * Flow:
     * 1. Initialize builder paths
     * 2. Create working directories
     * 3. Either restore from artifact OR initialize fresh environment
     * 4. Create .env configuration file if provided
     */
    async _setupEnvironment() {
        console.log('\n=== Setting Up Environment ===');

        // Initialize platform-specific paths in the builder
        if (typeof this.builder._ensurePaths === 'function') {
            this.builder._ensurePaths();
        }

        // Create the source directory structure if it doesn't exist
        try {
            await io.mkdirP(this.builder.paths.srcDir);
        } catch (e) {
            console.log('Work directory already exists');
        }

        // Choose between restoration from checkpoint or fresh initialization
        if (this.fromArtifact) {
            await this._restoreFromArtifact();
        } else {
            await this._initializeFromScratch();
        }

        // Create Brave configuration file from provided envConfig
        await this._createEnvFile();
    }

    /**
     * Initialize fresh build environment
     */
    async _initializeFromScratch() {
        console.log('Initializing fresh build environment...');
        await this.builder.initialize();
    }

    /**
     * Restore build environment from artifact
     */
    async _restoreFromArtifact() {
        console.log('Restoring build environment from artifact...');
        
        try {
            const exec = require('@actions/exec');
            
            // Create platform-specific artifact name to avoid conflicts between parallel builds
            const checkpointArtifactName = `${ARTIFACTS.BUILD_STATE}-${this.platform}-${this.arch}`;
            
            // Platform-specific restoration
            if (this.platform === 'windows') {
                // Windows uses simple 7z extraction
                console.log('Extracting 7z checkpoint (Windows)...');
                await extractWindowsCheckpoint(
                    this.builder.paths.workDir,
                    this.artifact,
                    checkpointArtifactName
                );
            } else {
                // Linux/macOS use multi-volume tar archives
                // Platform-specific dependency installation
                if (this.platform === 'linux') {
                    console.log('Installing zstd for decompression (Linux)...');
                    await exec.exec('sudo', ['apt-get', 'update'], {ignoreReturnCode: true});
                    await exec.exec('sudo', ['apt-get', 'install', '-y', 'zstd'], {ignoreReturnCode: true});
                } else if (this.platform === 'macos') {
                    console.log('Installing dependencies via Homebrew (macOS)...');
                    await exec.exec('brew', ['install', 'coreutils'], {ignoreReturnCode: true});
                }
                
                // Extract multi-volume archive
                console.log(`Extracting checkpoint artifact: ${checkpointArtifactName}...`);
                const tarCommand = this.builder.config.tarCommand || 'tar';
                await extractMultiVolumeArchive(
                    this.builder.paths.workDir,
                    this.artifact,
                    checkpointArtifactName,
                    {tarCommand}
                );
            }

            // Install build dependencies (Linux only)
            if (this.platform === 'linux') {
                console.log('Installing Chromium build dependencies...');
                const buildDepsScript = path.join(this.builder.paths.srcDir, 'build', 'install-build-deps.sh');
                await exec.exec('sudo', [buildDepsScript, '--no-prompt'], {ignoreReturnCode: true});
            }
            
            // Setup Xcode environment on macOS (for SDK consistency)
            if (this.platform === 'macos') {
                console.log('\n=== Re-initializing Xcode Environment (Post-Restore) ===');
                console.log('Ensuring consistent Xcode/SDK selection after checkpoint restore...');
                // Call the builder's Xcode setup to ensure we use the same Xcode version
                if (typeof this.builder._setupXcode === 'function') {
                    await this.builder._setupXcode();
                }
                console.log('✓ Xcode environment re-initialized');
            }

        } catch (e) {
            console.error(`Failed to restore from artifact: ${e.message}`);
            throw e;
        }
    }

    /**
     * Execute the build stages in sequence with intelligent stage management
     *
     * This method implements the core build pipeline with stage progression logic:
     *
     * Stage 1 (INIT): Clone repositories, install dependencies, setup environment
     * Stage 2 (BUILD): Compile Chromium/Brave (most time-consuming, ~4-5 hours)
     * Stage 3 (PACKAGE): Create distributable packages and prepare for upload
     *
     * The method handles:
     * - Stage state persistence via marker files
     * - Timeout detection and checkpoint creation
     * - Disk usage analysis between stages
     * - Platform-specific build logic delegation
     *
     * @returns {Promise<boolean>} true if build completed successfully, false if timed out/failed
     */
    async _runBuildStages() {
        const currentStage = await this.builder.getCurrentStage();
        console.log(`\n=== Running Build Stages (current: ${currentStage}) ===`);
        const diskAnalyzer = new DiskAnalyzer(this.platform, this.arch);

        // Stage 1: npm run init
        if (currentStage === STAGES.INIT) {
            const initSuccess = await this.builder.runInit();
            
            if (initSuccess) {
                await this.builder.setStage(STAGES.BUILD);
                await diskAnalyzer.analyze('post-init');
            } else {
                console.log('Init stage failed, will retry in next run');
                return false;
            }
        }

        // Stage 2: npm run build
        // Note: For Release builds, create_dist is now unified with build (--target=create_dist)
        // so we go directly to PACKAGE stage after successful build
        if (currentStage === STAGES.BUILD || await this.builder.getCurrentStage() === STAGES.BUILD) {
            const buildResult = await this.builder.runBuild();
            
            if (buildResult.success) {
                // Both Release and Component builds go directly to PACKAGE stage
                // (Release builds include create_dist in the unified build command)
                await this.builder.setStage(STAGES.PACKAGE);
                await diskAnalyzer.analyze('post-build');
                return true;
            } else if (buildResult.timedOut) {
                console.log('Build timed out, will resume in next run');
                return false;
            } else {
                console.log('Build failed, will retry in next run');
                return false;
            }
        }

        // If we're at package stage, build was successful
        const finalStage = await this.builder.getCurrentStage();
        return finalStage === STAGES.PACKAGE;
    }

    /**
     * Package and upload final artifact
     */
    async _packageAndUpload() {
        console.log('\n=== Packaging Final Build ===');
        
        const {packagePath, packageName} = await this.builder.package();
        
        // Upload final artifact
        console.log('\nUploading final artifact...');
        // Include architecture in artifact name if it's not x64 (default)
        const artifactName = this.arch === 'x64' 
            ? `${ARTIFACTS.FINAL_PACKAGE}-${this.platform}`
            : `${ARTIFACTS.FINAL_PACKAGE}-${this.platform}-${this.arch}`;
        
        await this.artifact.uploadArtifact(
            artifactName,
            [packagePath],
            this.builder.paths.workDir,
            {retentionDays: ARCHIVE.FINAL_RETENTION_DAYS}
        );

        console.log('✓ Final artifact uploaded successfully');
    }

    /**
     * Create checkpoint artifact for resumption
     */
    async _createCheckpoint() {
        console.log('\n=== Creating Checkpoint Artifact ===');
        
        // Delete .env file before checkpointing (SECURITY: prevent secrets in artifacts)
        await this._deleteEnvFile();
        
        // Wait for filesystem sync
        await waitAndSync(TIMEOUTS.CLEANUP_WAIT);
        await waitAndSync(TIMEOUTS.SYNC_WAIT);
        
        // Create platform-specific artifact name to avoid conflicts between parallel builds
        const checkpointArtifactName = `${ARTIFACTS.BUILD_STATE}-${this.platform}-${this.arch}`;
        
        try {
            if (this.platform === 'windows') {
                // Windows uses simple 7z compression
                console.log(`\nCreating 7z checkpoint artifact: ${checkpointArtifactName}...`);
                await createWindowsCheckpoint(
                    this.builder.paths.workDir,
                    ['src', 'build-stage.txt'],
                    this.artifact,
                    checkpointArtifactName
                );
            } else {
                // Linux/macOS use multi-volume tar archives
                // Clean up previous artifacts safely
                console.log('Cleaning up previous artifacts...');
                try {
                    await this.artifact.deleteArtifact(`${checkpointArtifactName}-manifest`);
                } catch (e) { /* Ignore error */ }
                
                for (let i = 1; i <= ARCHIVE.MAX_VOLUMES; i++) {
                    try {
                        await this.artifact.deleteArtifact(`${checkpointArtifactName}-vol${i.toString().padStart(3, '0')}`);
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (e) { /* Ignore error */ }
                }
                
                console.log(`\nCreating multi-volume checkpoint artifact: ${checkpointArtifactName}...`);
                const volumeSize = this.builder.config.volumeSize;
                console.log('This will:');
                console.log(`  1. Create tar volumes of size ${volumeSize} each`);
                console.log('  2. Compress each volume with zstd');
                console.log('  3. Upload compressed volume');
                console.log('  4. Delete volume files immediately');
                console.log('  5. Repeat for each volume\n');
                
                const tarCommand = this.builder.config.tarCommand || 'tar';
                const volumeCount = await createMultiVolumeArchive(
                    'build-state',
                    this.builder.paths.workDir,
                    ['src', 'build-stage.txt'],
                    this.artifact,
                    checkpointArtifactName,
                    { tarCommand, volumeSize }
                );
                
                console.log(`\n✓ Successfully created and uploaded ${volumeCount} volume(s)`);
            }
        } catch (e) {
            console.error(`Failed to create checkpoint: ${e.message}`);
            throw e;
        }
    }
    
    /**
     * Create .env file in brave directory from envConfig
     */
    async _createEnvFile() {
        if (!this.envConfig) {
            console.log('No .env configuration provided, skipping .env file creation');
            return;
        }
        
        console.log('\n=== Creating .env File ===');
        const envFilePath = path.join(this.builder.paths.braveDir, '.env');
        
        try {
            await fs.writeFile(envFilePath, this.envConfig);
            console.log(`✓ Created .env file at ${envFilePath}`);
            console.log(`  (${this.envConfig.split('\n').length} lines)`);
        } catch (e) {
            console.error(`Failed to create .env file: ${e.message}`);
            throw e;
        }
    }
    
    /**
     * Delete .env file before checkpointing (security measure)
     */
    async _deleteEnvFile() {
        const envFilePath = path.join(this.builder.paths.braveDir, '.env');
        
        try {
            await fs.unlink(envFilePath);
            console.log('✓ Deleted .env file (security: preventing secrets in checkpoint artifact)');
        } catch (e) {
            if (e.code === 'ENOENT') {
                console.log('No .env file to delete (already absent)');
            } else {
                console.warn(`Warning: Failed to delete .env file: ${e.message}`);
            }
        }
    }
    
    /**
     * Clean up checkpoint artifacts after successful build completion
     */
    async _cleanupCheckpointArtifacts() {
        console.log('\n=== Cleaning Up Checkpoint Artifacts ===');
        console.log('Build completed successfully, checkpoint artifacts no longer needed');
        
        const checkpointArtifactName = `${ARTIFACTS.BUILD_STATE}-${this.platform}-${this.arch}`;
        let deletedCount = 0;
        
        try {
            if (this.platform === 'windows') {
                // Windows: single artifact
                console.log(`Deleting Windows checkpoint artifact: ${checkpointArtifactName}...`);
                try {
                    await this.artifact.deleteArtifact(checkpointArtifactName);
                    deletedCount++;
                    console.log(`  ✓ Deleted ${checkpointArtifactName}`);
                } catch (e) {
                    if (e.message && e.message.includes('not found')) {
                        console.log(`  ℹ No checkpoint artifact found (clean slate)`);
                    } else {
                        console.warn(`  ⚠️ Could not delete ${checkpointArtifactName}: ${e.message}`);
                    }
                }
            } else {
                // Linux/macOS: manifest + volume artifacts
                console.log(`Deleting checkpoint artifacts: ${checkpointArtifactName}-*...`);
                
                // Delete manifest
                try {
                    await this.artifact.deleteArtifact(`${checkpointArtifactName}-manifest`);
                    deletedCount++;
                    console.log(`  ✓ Deleted ${checkpointArtifactName}-manifest`);
                } catch (e) {
                    if (e.message && e.message.includes('not found')) {
                        console.log(`  ℹ No manifest found (clean slate)`);
                    } else {
                        console.warn(`  ⚠️ Could not delete manifest: ${e.message}`);
                    }
                }
                
                // Delete volume artifacts
                for (let i = 1; i <= ARCHIVE.MAX_VOLUMES; i++) {
                    const volumeName = `${checkpointArtifactName}-vol${i.toString().padStart(3, '0')}`;
                    try {
                        await this.artifact.deleteArtifact(volumeName);
                        deletedCount++;
                        console.log(`  ✓ Deleted ${volumeName}`);
                    } catch (e) {
                        // Stop when we hit a non-existent volume (we've deleted all that exist)
                        if (e.message && e.message.includes('not found')) {
                            // No more volumes to delete
                            break;
                        } else {
                            console.warn(`  ⚠️ Could not delete ${volumeName}: ${e.message}`);
                        }
                    }
                }
            }
            
            if (deletedCount > 0) {
                console.log(`✓ Cleaned up ${deletedCount} checkpoint artifact(s)`);
            } else {
                console.log('ℹ No checkpoint artifacts to clean up (build completed on first run)');
            }
            
        } catch (e) {
            // Don't fail the build if cleanup fails
            console.warn(`Warning: Failed to clean up checkpoint artifacts: ${e.message}`);
            console.warn('This is not critical - artifacts will expire based on retention policy');
        }
    }
}

/**
 * Read the Brave browser version from the repository's version file
 *
 * This function reads the brave_version.txt file which contains the specific
 * Brave version tag to build (e.g., "v1.50.100"). The version is used for:
 * - Git checkout of the correct brave-core tag
 * - Package naming and metadata
 * - Build configuration validation
 *
 * @param {string} repoPath - Path to the repository root directory
 * @returns {Promise<string>} The Brave version string (e.g., "v1.50.100")
 * @throws {Error} If the version file cannot be read or is empty
 */
async function readBraveVersion(repoPath) {
    const versionFile = path.join(repoPath, 'brave_version.txt');

    try {
        const version = (await fs.readFile(versionFile, 'utf-8')).trim();

        if (!version) {
            throw new Error('brave_version.txt is empty');
        }

        console.log(`Building Brave version: ${version} (from brave_version.txt)`);
        return version;
    } catch (e) {
        throw new Error(`Failed to read brave_version.txt: ${e.message}`);
    }
}

module.exports = {
    BuildOrchestrator,
    readBraveVersion
};

