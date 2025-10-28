/**
 * Main entry point for the Brave Browser build GitHub Action
 * 
 * This action supports multi-stage builds across multiple platforms and architectures.
 * It handles:
 * - Build orchestration across multiple stages
 * - Checkpoint/resume functionality via artifacts
 * - Multi-platform support (Linux, macOS, Windows)
 * - Multi-architecture support (x64, arm64)
 */

const core = require('@actions/core');
const path = require('path');
const {BuildOrchestrator, readBraveVersion} = require('./orchestrator');

/**
 * Main action entry point
 */
async function run() {
    try {
        // Read inputs
        const finished = core.getBooleanInput('finished', {required: true});
        const fromArtifact = core.getBooleanInput('from_artifact', {required: true});
        const platform = core.getInput('platform') || 'linux';
        const arch = core.getInput('arch') || 'x64';
        
        // Determine repository path based on platform
        // TODO: Make this more flexible/configurable
        const repoPath = '/home/runner/work/peasant-brave-portablelinux/peasant-brave-portablelinux';
        
        // Read Brave version from repository
        const braveVersion = await readBraveVersion(repoPath);
        
        // Create and run orchestrator
        const orchestrator = new BuildOrchestrator({
            finished,
            fromArtifact,
            braveVersion,
            platform,
            arch
        });
        
        await orchestrator.run();
        
    } catch (error) {
        core.setFailed(error.message);
        console.error(error.stack);
    }
}

// Run the action
run();

