/**
 * Main entry point for the Brave Browser build GitHub Action
 *
 * This action orchestrates complex, multi-stage Chromium-based browser builds that can take
 * 12+ hours to complete. It breaks down the build process into resumable stages to work within
 * GitHub Actions' 6-hour timeout limit.
 *
 * Key capabilities:
 * - Multi-stage build orchestration (init → build → package)
 * - Checkpoint/resume via GitHub Artifacts (handles timeouts gracefully)
 * - Cross-platform support (Linux, macOS, Windows) 
 * - Multi-architecture support (x64, arm64, x86 for Windows)
 * - Build type flexibility (Component / Release)
 * - Security-conscious artifact handling (no secrets in checkpoints, encrypted build artifacts)
 */

const core = require('@actions/core');
const path = require('path');
const {BuildOrchestrator, readBraveVersion} = require('./orchestrator');

/**
 * Main GitHub Action entry point
 *
 * Reads action inputs, initializes the build orchestrator, and coordinates the entire
 * build process. This function serves as the bridge between GitHub Actions' input system
 * and the platform-specific build logic.
 */
async function run() {
    try {
        // ============================================================================
        // INPUT VALIDATION & CONFIGURATION
        // ============================================================================

        // Read required boolean inputs that control build flow
        const finished = core.getBooleanInput('finished', {required: true});     // Skip if build already completed
        const fromArtifact = core.getBooleanInput('from_artifact', {required: true}); // Resume from checkpoint

        // Read optional platform and architecture inputs with defaults
        const platform = core.getInput('platform') || 'linux';     // linux, macos, windows
        const arch = core.getInput('arch') || 'x64';              // x64, arm64, x86 (windows only)
        const buildType = core.getInput('build_type') || 'Component'; // Component (debug) or Release
        const envConfig = core.getInput('env_config') || '';      // .env file contents for Brave config

        // ============================================================================
        // ENVIRONMENT SETUP
        // ============================================================================

        // Get the repository workspace path (set by GitHub Actions runner)
        const repoPath = process.env.GITHUB_WORKSPACE;
        if (!repoPath) {
            throw new Error('GITHUB_WORKSPACE environment variable not set!');
        }

        // Read the Brave version tag from the repository's version file
        const braveVersion = await readBraveVersion(repoPath);

        // ============================================================================
        // BUILD INITIALIZATION
        // ============================================================================

        console.log(`Build configuration:`);
        console.log(`  - Build type: ${buildType}`);
        console.log(`  - .env config: ${envConfig ? 'provided' : 'not provided'}`);

        // Create the build orchestrator with all configuration
        // This object coordinates the entire build process across platforms
        const orchestrator = new BuildOrchestrator({
            finished,
            fromArtifact,
            braveVersion,
            platform,
            arch,
            buildType,
            envConfig
        });

        // Execute the build orchestration (this is where the heavy lifting happens)
        await orchestrator.run();

    } catch (error) {
        // Set the GitHub Action as failed and log the error details
        core.setFailed(error.message);
        console.error(error.stack);
    }
}

// Run the action
run();

