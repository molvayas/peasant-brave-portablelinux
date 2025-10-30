/**
 * Windows-specific disk cleanup
 */

const exec = require('@actions/exec');

class WindowsCleanup {
    constructor() {
        this.buildDirLocation = 'C:\\';
    }

    async showDiskSpace(indent = '') {
        await exec.exec('powershell', ['-Command', 
            `Write-Host "${indent}"; Get-PSDrive C | Select-Object @{Name="Drive";Expression={$_.Name}}, @{Name="Used(GB)";Expression={[math]::Round($_.Used/1GB,2)}}, @{Name="Free(GB)";Expression={[math]::Round($_.Free/1GB,2)}}, @{Name="Total(GB)";Expression={[math]::Round(($_.Used+$_.Free)/1GB,2)}} | Format-Table -AutoSize`
        ], {ignoreReturnCode: true});
    }

    async run() {
        console.log('=== Runner Disk Space Cleanup (Windows) ===');
        console.log('Removing pre-installed tools from GitHub Actions runner');
        console.log('(Source tree cleanup happens later in the build stage)');
        console.log(`\nChecking disk space for: ${this.buildDirLocation}`);
        console.log('\nBEFORE cleanup:');
        await this.showDiskSpace();
        
        console.log('\nFreeing disk space on runner...\n');
        
        // Create empty directory for robocopy trick
        const emptyDir = 'C:\\empty_temp_dir';
        await exec.exec('cmd', ['/c', 'mkdir', emptyDir], {ignoreReturnCode: true});
        
        // Define cleanup targets with names
        const cleanupDirs = [
            {path: 'C:\\Program Files (x86)\\Android', name: 'Android SDK'},
            {path: 'C:\\ghcup', name: 'Haskell toolchain'},
            {path: 'C:\\rtools45', name: 'R tools'},
            {path: 'C:\\Julia', name: 'Julia'},
            {path: 'C:\\Miniconda', name: 'Miniconda'},
            {path: 'C:\\mingw64', name: 'MinGW64'},
            {path: 'C:\\mingw32', name: 'MinGW32'},
            {path: 'C:\\Strawberry', name: 'Strawberry Perl'}
            // NOTE: Don't remove C:\\msys64 - we need GNU tar and zstd from here
        ];
        
        // Remove each directory with before/after
        // Use robocopy /MIR trick - MUCH faster than rd or Remove-Item for large directories
        for (const {path: dir, name} of cleanupDirs) {
            console.log(`Removing ${name} (${dir})...`);
            console.log('  Before:');
            await this.showDiskSpace('  ');
            
            // Robocopy trick: mirror empty dir to target (deletes everything), then remove both
            // /MIR = mirror, /R:0 = no retries, /W:0 = no wait
            // /MT:8 = 8 threads (optimal for GitHub 4-core runners)
            // /LOG:NUL = don't generate log (faster)
            await exec.exec('robocopy', [
                emptyDir, dir,
                '/MIR', '/R:0', '/W:0', '/MT:8', '/LOG:NUL'
            ], {ignoreReturnCode: true});
            await exec.exec('cmd', ['/c', 'rmdir', dir], {ignoreReturnCode: true});
            
            console.log('  After:');
            await this.showDiskSpace('  ');
            console.log('');
        }
        
        // Try Docker system prune
        console.log('Pruning Docker (docker system prune -a)...');
        console.log('  Before:');
        await this.showDiskSpace('  ');
        
        try {
            await exec.exec('docker', ['system', 'prune', '-a', '-f', '--volumes'], {
                ignoreReturnCode: true
            });
        } catch (e) {
            console.log('  Docker not available or prune failed');
        }
        
        console.log('  After:');
        await this.showDiskSpace('  ');
        
        // Remove Docker data directory after prune
        console.log('\nRemoving Docker data directory (C:\\ProgramData\\docker)...');
        console.log('  Before:');
        await this.showDiskSpace('  ');
        
        // Use robocopy trick for Docker directory too
        const dockerDir = 'C:\\ProgramData\\docker';
        await exec.exec('robocopy', [
            emptyDir, dockerDir,
            '/MIR', '/R:0', '/W:0', '/MT:8', '/LOG:NUL'
        ], {ignoreReturnCode: true});
        await exec.exec('cmd', ['/c', 'rmdir', dockerDir], {ignoreReturnCode: true});
        
        console.log('  After:');
        await this.showDiskSpace('  ');
        
        // Clean up empty directory
        await exec.exec('cmd', ['/c', 'rmdir', emptyDir], {ignoreReturnCode: true});
        
        console.log('\n✓ Cleanup complete');
        console.log(`FINAL disk space available for ${this.buildDirLocation}:`);
        await this.showDiskSpace();
        console.log('===========================\n');
    }
}

module.exports = WindowsCleanup;
