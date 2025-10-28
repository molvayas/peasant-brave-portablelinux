const exec = require('@actions/exec');
const path = require('path');

/**
 * Show disk usage for the home directory
 */
async function showDiskSpace(indent = '') {
    await exec.exec('df', ['-h', process.env.HOME], {ignoreReturnCode: true});
    if (indent) {
        console.log(''); // Add spacing when indented
    }
}

async function run() {
    const buildDirLocation = process.env.HOME;
    
    console.log('=== Runner Disk Space Cleanup (macOS) ===');
    console.log('Removing pre-installed simulators and tools from GitHub Actions runner');
    console.log('(Source tree cleanup happens later in the build stage)');
    console.log(`\nChecking disk space for: ${buildDirLocation}`);
    console.log('\nBEFORE cleanup:');
    await showDiskSpace();
    
    console.log('\nFreeing disk space on runner...\n');
    
    // Disable Spotlight indexing to save disk space and CPU/IO
    console.log('Disabling Spotlight indexing...');
    console.log('  Before:');
    await showDiskSpace('  ');
    await exec.exec('sudo', ['mdutil', '-a', '-i', 'off'], {ignoreReturnCode: true});
    console.log('  After:');
    await showDiskSpace('  ');
    console.log('');
    
    // Define cleanup targets with names
    const assetsV2Path = '/System/Volumes/Data/System/Library/AssetsV2';
    const cleanupDirs = [
        {path: `${assetsV2Path}/com_apple_MobileAsset_iOSSimulatorRuntime`, name: 'iOS Simulator Runtime (~32 GB)'},
        {path: `${assetsV2Path}/com_apple_MobileAsset_xrOSSimulatorRuntime`, name: 'xrOS Simulator Runtime (~30 GB)'},
        {path: `${assetsV2Path}/com_apple_MobileAsset_watchOSSimulatorRuntime`, name: 'watchOS Simulator Runtime (~17 GB)'},
        {path: `${assetsV2Path}/com_apple_MobileAsset_appleTVOSSimulatorRuntime`, name: 'tvOS Simulator Runtime (~16 GB)'},
        {path: path.join(process.env.HOME, 'Library', 'Android'), name: 'Android SDK'},
        {path: path.join(process.env.HOME, '.android'), name: 'Android cache'},
        {path: '/usr/local/lib/android', name: 'Android (system)'}
    ];
    
    // Add ANDROID_HOME if it exists
    if (process.env.ANDROID_HOME) {
        cleanupDirs.unshift({
            path: process.env.ANDROID_HOME,
            name: `Android Home (${process.env.ANDROID_HOME})`
        });
    }
    
    // Remove each directory with before/after
    for (const {path: dir, name} of cleanupDirs) {
        console.log(`Removing ${name} (${dir})...`);
        console.log('  Before:');
        await showDiskSpace('  ');
        
        await exec.exec('sudo', ['rm', '-rf', dir], {ignoreReturnCode: true});
        
        console.log('  After:');
        await showDiskSpace('  ');
        console.log('');
    }
    
    console.log('✓ Cleanup complete');
    console.log(`FINAL disk space available for ${buildDirLocation}:`);
    await showDiskSpace();
    console.log('===========================\n');
}

run().catch(err => {
    console.error(`Cleanup failed: ${err.message}`);
    process.exit(1);
});

