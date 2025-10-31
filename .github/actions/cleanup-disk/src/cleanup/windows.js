/**
 * Windows-specific disk cleanup
 */

const exec = require('@actions/exec');

class WindowsCleanup {
    constructor() {
        this.buildDirLocation = 'C:\\';
    }

    async showDiskSpace(indent = '') {
        await exec.exec('powershell', ['-Command', 'Get-Volume | Format-Table -AutoSize'], {ignoreReturnCode: true});
    }

    async run() {
        console.log('=== Runner Disk Space Cleanup (Windows) ===');
        console.log('\nCleanup on C: drive is temporarily disabled as the build process now runs on the D: drive.');
        console.log('Reporting current disk space usage without making changes.');
        
        console.log(`\nDisk space status:`);
        await this.showDiskSpace();
        console.log('===========================\n');
        return; // Skip the actual cleanup

        // The original cleanup logic is preserved below and can be re-enabled by removing the 'return' above.

        console.log('Removing pre-installed tools from GitHub Actions runner');
        
        console.log(`\nChecking disk space for: ${this.buildDirLocation}`);
        console.log('\nBEFORE cleanup:');
        await this.showDiskSpace();
        
        console.log('\nFreeing disk space on runner...\n');
        
        const emptyDir = 'C:\\empty_temp_dir';
        await exec.exec('cmd', ['/c', 'mkdir', emptyDir], {ignoreReturnCode: true});
        
        const cleanupDirs = [
            {path: 'C:\\Program Files (x86)\\Android', name: 'Android SDK'},
            {path: 'C:\\ghcup', name: 'Haskell toolchain'},
            {path: 'C:\\rtools45', name: 'R tools'},
            {path: 'C:\\Julia', name: 'Julia'},
            {path: 'C:\\Miniconda', name: 'Miniconda'},
            {path: 'C:\\mingw64', name: 'MinGW64'},
            {path: 'C:\\mingw32', name: 'MinGW32'},
            {path: 'C:\\Strawberry', name: 'Strawberry Perl'}
        ];
        
        for (const {path: dir, name} of cleanupDirs) {
            console.log(`Removing ${name} (${dir})...`);
            await exec.exec('robocopy', [emptyDir, dir, '/MIR', '/R:0', '/W:0', '/MT:8', '/LOG:NUL'], {ignoreReturnCode: true});
            await exec.exec('cmd', ['/c', 'rmdir', dir], {ignoreReturnCode: true});
        }
        
        console.log('Pruning Docker (docker system prune -a)...');
        try {
            await exec.exec('docker', ['system', 'prune', '-a', '-f', '--volumes'], {ignoreReturnCode: true});
        } catch (e) {
            console.log('  Docker not available or prune failed');
        }
        
        const dockerDir = 'C:\\ProgramData\\docker';
        await exec.exec('robocopy', [emptyDir, dockerDir, '/MIR', '/R:0', '/W:0', '/MT:8', '/LOG:NUL'], {ignoreReturnCode: true});
        await exec.exec('cmd', ['/c', 'rmdir', dockerDir], {ignoreReturnCode: true});
        await exec.exec('cmd', ['/c', 'rmdir', emptyDir], {ignoreReturnCode: true});
        
        console.log('\n✓ Cleanup complete');
        console.log(`FINAL disk space available for ${this.buildDirLocation}:`);
        await this.showDiskSpace();
        console.log('===========================\n');
    }
}

module.exports = WindowsCleanup;
