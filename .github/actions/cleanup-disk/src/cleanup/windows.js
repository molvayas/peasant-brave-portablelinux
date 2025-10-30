/**
 * Windows-specific disk cleanup
 */

const exec = require('@actions/exec');
const core = require('@actions/core');
const {DefaultArtifactClient} = require('@actions/artifact');
const fs = require('fs').promises;
const path = require('path');

class WindowsCleanup {
    constructor() {
        this.buildDirLocation = 'C:\\';
        this.artifact = new DefaultArtifactClient();
    }

    async showDiskSpace() {
        await exec.exec('powershell', ['-Command', 'Get-Volume | Format-Table -AutoSize'], {ignoreReturnCode: true});
    }

    async _installGdu() {
        console.log('Downloading gdu...');
        const gduUrl = 'https://github.com/dundee/gdu/releases/download/v5.31.0/gdu_windows_amd64.exe.zip';
        const gduZipPath = path.join(process.env.RUNNER_TEMP, 'gdu.zip');
        const gduExtractPath = path.join(process.env.RUNNER_TEMP, 'gdu_extracted');

        await exec.exec('powershell', ['-Command', `Invoke-WebRequest -Uri ${gduUrl} -OutFile ${gduZipPath}`]);

        console.log('Extracting gdu...');
        await fs.mkdir(gduExtractPath, { recursive: true });
        await exec.exec('powershell', ['-Command', `Expand-Archive -Path ${gduZipPath} -DestinationPath ${gduExtractPath}`]);

        const gduExePath = path.join(gduExtractPath, 'gdu_windows_amd64.exe');
        const finalGduPath = path.join(gduExtractPath, 'gdu.exe');
        await fs.rename(gduExePath, finalGduPath);

        core.addPath(gduExtractPath);
        console.log('gdu has been added to the PATH for this job.');

        return { gduZipPath, gduExtractPath };
    }

    async _runGduAnalysisAndUpload(artifactName, drive) {
        const reportFile = `gdu-report-${drive}.json`;
        const reportPath = path.join(process.env.RUNNER_TEMP, reportFile);
        
        console.log(`\nRunning gdu scan on ${drive}: drive...`);
        await exec.exec('gdu', ['-n', '-o', reportPath, `${drive}:\\`], {
            ignoreReturnCode: true
        });

        console.log(`Uploading ${artifactName} artifact...`);
        try {
            await this.artifact.uploadArtifact(
                artifactName,
                [reportPath],
                process.env.RUNNER_TEMP
            );
            await fs.unlink(reportPath);
        } catch (e) {
            core.warning(`Failed to upload artifact ${artifactName}: ${e.message}`);
        }
    }

    async run() {
        console.log('=== Runner Disk Space Cleanup (Windows) ===');
        
        let gduPaths = null;
        try {
            gduPaths = await this._installGdu();

            console.log('\nBEFORE cleanup:');
            await this.showDiskSpace();
            await this._runGduAnalysisAndUpload('disk-usage-before-windows-C', 'C');
            await this._runGduAnalysisAndUpload('disk-usage-before-windows-D', 'D');

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

            console.log('=== Disk Usage Analysis (After Cleanup) ===');
            await this._runGduAnalysisAndUpload('disk-usage-after-windows-C', 'C');
            await this._runGduAnalysisAndUpload('disk-usage-after-windows-D', 'D');

        } finally {
            if (gduPaths) {
                console.log('Cleaning up downloaded gdu files...');
                try {
                    await fs.unlink(gduPaths.gduZipPath);
                    await fs.rm(gduPaths.gduExtractPath, { recursive: true, force: true });
                } catch (e) {
                    core.warning(`Failed to clean up gdu files: ${e.message}`);
                }
            }
        }
    }
}

module.exports = WindowsCleanup;
