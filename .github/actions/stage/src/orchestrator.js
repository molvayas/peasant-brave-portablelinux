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
        
        // Track job start time for timeout calculations
        // This is set at orchestrator creation (top of action run)
        this.jobStartTime = Date.now();
        
        this.artifact = new DefaultArtifactClient();
        this.builder = createBuilder(this.platform, this.braveVersion, this.arch);
        
        // Pass job start time to builder
        this.builder.jobStartTime = this.jobStartTime;
        
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
        console.log(`Finished: ${this.finished}`);
        console.log(`From Artifact: ${this.fromArtifact}`);
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

        } catch (e) {
            console.error(`Failed to restore from artifact: ${e.message}`);
            throw e;
        }
    }

    /**
     * Run build stages (init -> build -> package)
     */
    async _runBuildStages() {
        const currentStage = await this.builder.getCurrentStage();
        console.log(`\n=== Running Build Stages (current: ${currentStage}) ===`);
        const diskAnalyzer = new DiskAnalyzer(this.platform);

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
        const artifactName = `${ARTIFACTS.FINAL_PACKAGE}-${this.platform}`;
        
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

