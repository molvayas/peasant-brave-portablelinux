const core = require('@actions/core');
const exec = require('@actions/exec');

async function run() {
    try {
        const buildDirLocation = '/home/runner';
        
        console.log('=== Disk Space Management ===');
        console.log(`Checking disk space for: ${buildDirLocation}`);
        console.log('\nBEFORE cleanup:');
        await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
        
        console.log('\nFreeing disk space on runner...\n');
        const cleanupDirs = [
            {path: '/usr/share/dotnet', name: '.NET SDK'},
            {path: '/usr/local/lib/android', name: 'Android SDK'},
            {path: '/usr/local/.ghcup', name: 'GHC/Haskell'},
            {path: '/usr/lib/jvm', name: 'Java JDKs'},
            {path: '/usr/lib/google-cloud-sdk', name: 'Google Cloud SDK'},
            {path: '/usr/share/swift', name: 'Swift'},
            {path: '/opt/ghc', name: 'GHC (opt)'},
            // {path: '/opt/hostedtoolcache', name: 'Hosted Tool Cache'},
            {path: '/usr/local/julia', name: 'Julia'},
            {path: '/opt/az', name: 'Azure CLI'},
            {path: '/usr/local/share/powershell', name: 'PowerShell'},
            {path: '/usr/local/share/chromium', name: 'Chromium'},
            {path: '/opt/microsoft', name: 'Microsoft Edge/Chrome'},
            {path: '/opt/google', name: 'Google Chrome'},
            {path: '/usr/lib/firefox', name: 'Firefox'}
        ];
        
        for (const {path: dir, name} of cleanupDirs) {
            try {
                console.log(`Removing ${name} (${dir})...`);
                console.log('  Before:');
                await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
                
                await exec.exec('sudo', ['rm', '-rf', dir], {ignoreReturnCode: true});
                
                console.log('  After:');
                await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
                console.log('');
            } catch (e) {
                console.log(`  Skipped (doesn't exist or already removed)\n`);
            }
        }
        
        // Prune Docker system
        console.log('Pruning Docker system...');
        console.log('  Before:');
        await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
        try {
            await exec.exec('sudo', ['docker', 'system', 'prune', '--all', '--force'], {ignoreReturnCode: true});
            await exec.exec('sudo', ['docker', 'builder', 'prune', '--all', '--force'], {ignoreReturnCode: true});
        } catch (e) {
            console.log('  Docker not available');
        }
        console.log('  After:');
        await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
        
        console.log('\n✓ Cleanup complete');
        console.log(`FINAL disk space available for ${buildDirLocation}:`);
        await exec.exec('df', ['-h', buildDirLocation], {ignoreReturnCode: true});
        console.log('===========================\n');
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
