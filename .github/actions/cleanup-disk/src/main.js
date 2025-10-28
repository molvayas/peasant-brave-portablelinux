/**
 * Main entry point for the disk cleanup action
 */

const core = require('@actions/core');
const {createCleanup} = require('./cleanup/factory');

async function run() {
    try {
        // Read platform input
        const platform = core.getInput('platform') || 'linux';
        
        console.log(`Platform: ${platform}\n`);
        
        // Create and run platform-specific cleanup
        const cleanup = createCleanup(platform);
        await cleanup.run();
        
    } catch (error) {
        core.setFailed(error.message);
        console.error(error.stack);
    }
}

run();

