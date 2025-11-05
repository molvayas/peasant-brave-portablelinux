/**
 * Build orchestrator - coordinates the entire build process
 * 
 * This orchestrator handles:
 * - Build initialization or restoration from artifacts
 * - Stage progression (init -> build -> package)
 * - Artifact management (checkpoint and final artifacts)
 * - Error handling and retries
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
    constructor(options) {
        this.finished = options.finished;
        this.fromArtifact = options.fromArtifact;
        this.braveVersion = options.braveVersion;
        this.platform = options.platform || 'linux';
        this.arch = options.arch || 'x64';
        this.buildType = options.buildType || 'Component';
        this.envConfig = options.envConfig || '';
        
        // Track job start time for timeout calculations
        // This is set at orchestrator creation (top of action run)
        this.jobStartTime = Date.now();
        
        this.artifact = new DefaultArtifactClient();
        this.builder = createBuilder(this.platform, this.braveVersion, this.arch);
        
        // Pass configuration to builder
        this.builder.jobStartTime = this.jobStartTime;
        this.builder.buildType = this.buildType;
        this.builder.envConfig = this.envConfig;
        
        // Filter debug messages from artifact operations
        setupArtifactDebugFilter();
    }

    /**
     * Main orchestration method
     */
    async run() {
        // Handle SIGINT gracefully
        process.on('SIGINT', function() {
            // Allow graceful shutdown
        });

        console.log('=== Brave Browser Build Orchestrator ===');
        console.log(`Platform: ${this.platform}`);
        console.log(`Architecture: ${this.arch}`);
        console.log(`Brave Version: ${this.braveVersion}`);
        console.log(`Build Type: ${this.buildType}`);
        console.log(`Finished: ${this.finished}`);
        console.log(`From Artifact: ${this.fromArtifact}`);
        console.log(`.env Config: ${this.envConfig ? 'Provided (will be created)' : 'Not provided'}`);
        console.log('========================================\n');

        // If already finished, just set output and exit
        if (this.finished) {
            console.log('Build already finished in previous stage');
            core.setOutput('finished', true);
            return;
        }

        let buildSuccess = false;

        try {
            // Setup or restore build environment
            await this._setupEnvironment();

            // Run build stages
            buildSuccess = await this._runBuildStages();

            if (buildSuccess) {
                // Package and upload final artifact
                await this._packageAndUpload();
                core.setOutput('finished', true);
            } else {
                // Create checkpoint artifact for next stage
                await this._createCheckpoint();
                core.setOutput('finished', false);
            }

        } catch (error) {
            console.error(`Build error: ${error.message}`);
            console.error(error.stack);
            
            // Try to create checkpoint even on error
            try {
                await this._createCheckpoint();
                core.setOutput('finished', false);
            } catch (checkpointError) {
                console.error(`Failed to create checkpoint: ${checkpointError.message}`);
                core.setFailed(`Build failed: ${error.message}`);
            }
        }
    }

    /**
     * Setup or restore build environment
     */
    async _setupEnvironment() {
        console.log('\n=== Setting Up Environment ===');
        
        // Ensure paths are initialized before accessing them
        if (typeof this.builder._ensurePaths === 'function') {
            this.builder._ensurePaths();
        }
        
        // Ensure work directory exists
        try {
            await io.mkdirP(this.builder.paths.srcDir);
        } catch (e) {
            console.log('Work directory already exists');
        }

        if (this.fromArtifact) {
            await this._restoreFromArtifact();
        } else {
            await this._initializeFromScratch();
        }
        
        // Create .env file if configuration provided
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
                    console.log('Installing zstd and ncdu for decompression (Linux)...');
                    await exec.exec('sudo', ['apt-get', 'update'], {ignoreReturnCode: true});
                    await exec.exec('sudo', ['apt-get', 'install', '-y', 'zstd', 'ncdu'], {ignoreReturnCode: true});
                } else if (this.platform === 'macos') {
                    console.log('Installing dependencies via Homebrew (macOS)...');
                    await exec.exec('brew', ['install', 'coreutils', 'ncdu'], {ignoreReturnCode: true});
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
            
            // Clean PCM files on macOS to prevent SDK path conflicts
            if (this.platform === 'macos') {
                console.log('\n=== Cleaning PCM Files (macOS) ===');
                console.log('Removing precompiled C++ module files to prevent SDK path conflicts...');
                console.log('These files will be regenerated with the current Xcode/SDK paths (~1-2 minutes)');
                
                const outDir = path.join(this.builder.paths.srcDir, 'out');
                
                // Check if out directory exists
                try {
                    await fs.access(outDir);
                    
                    // Delete all .pcm files in the out directory
                    const pcmCount = await exec.exec('find', [
                        outDir,
                        '-name', '*.pcm',
                        '-type', 'f',
                        '-delete',
                        '-print'
                    ], {ignoreReturnCode: true});
                    
                    console.log('✓ PCM files cleaned successfully');
                    console.log('  Ninja will regenerate these files with correct SDK paths on next build');
                } catch (e) {
                    console.log('No out directory found yet, skipping PCM cleanup');
                }
            }

        } catch (e) {
            console.error(`Failed to restore from artifact: ${e.message}`);
            throw e;
        }
    }

    /**
     * Run build stages (init -> build -> build_dist -> package)
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
        if (currentStage === STAGES.BUILD || await this.builder.getCurrentStage() === STAGES.BUILD) {
            const buildResult = await this.builder.runBuild();
            
            if (buildResult.success) {
                // For Release builds, go to BUILD_DIST stage; for Component, go to PACKAGE
                if (this.buildType === 'Release') {
                    await this.builder.setStage(STAGES.BUILD_DIST);
                    await diskAnalyzer.analyze('post-build');
                } else {
                    await this.builder.setStage(STAGES.PACKAGE);
                    await diskAnalyzer.analyze('post-build');
                    return true;
                }
            } else if (buildResult.timedOut) {
                console.log('Build timed out, will resume in next run');
                return false;
            } else {
                console.log('Build failed, will retry in next run');
                return false;
            }
        }

        // Stage 3: create_dist (Release builds only)
        if (currentStage === STAGES.BUILD_DIST || await this.builder.getCurrentStage() === STAGES.BUILD_DIST) {
            // Check if builder has runBuildDist method
            if (typeof this.builder.runBuildDist !== 'function') {
                console.log('Builder does not support runBuildDist, skipping to package stage');
                await this.builder.setStage(STAGES.PACKAGE);
                return true;
            }
            
            const distResult = await this.builder.runBuildDist();
            
            if (distResult.success) {
                await this.builder.setStage(STAGES.PACKAGE);
                await diskAnalyzer.analyze('post-dist');
                return true;
            } else if (distResult.timedOut) {
                console.log('create_dist timed out, will resume in next run');
                return false;
            } else {
                console.log('create_dist failed, will retry in next run');
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
                    } catch (e) { /* Ignore error */ }
                }
                
                console.log(`\nCreating multi-volume checkpoint artifact: ${checkpointArtifactName}...`);
                console.log('This will:');
                console.log('  1. Create 5GB tar volumes');
                console.log('  2. Compress each volume with zstd');
                console.log('  3. Upload compressed volume');
                console.log('  4. Delete volume files immediately');
                console.log('  5. Repeat for each volume\n');
                
                const tarCommand = this.builder.config.tarCommand || 'tar';
                const volumeSize = this.builder.config.volumeSize;
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
}

/**
 * Read Brave version from version file
 */
async function readBraveVersion(repoPath) {
    const versionFile = path.join(repoPath, 'brave_version.txt');
    
    try {
        const version = (await fs.readFile(versionFile, 'utf-8')).trim();
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

