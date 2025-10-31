/**
 * Disk usage analysis utility using gdu
 */

const core = require('@actions/core');
const exec = require('@actions/exec');
const { DefaultArtifactClient } = require('@actions/artifact');
const fs = require('fs').promises;
const path = require('path');
const io = require('@actions/io');

class DiskAnalyzer {
    constructor(platform, arch) {
        this.platform = platform;
        this.arch = arch;
        this.artifact = new DefaultArtifactClient();
        this.gduCommand = 'gdu';
    }

    async _installGdu() {
        console.log(`\nInstalling gdu for ${this.platform}...`);
        try {
            if (this.platform === 'linux') {
                await exec.exec('sudo', ['apt-get', 'update']);
                await exec.exec('sudo', ['apt-get', 'install', '-y', 'gdu']);
            } else if (this.platform === 'macos') {
                await exec.exec('brew', ['install', 'gdu']);
                this.gduCommand = 'gdu-go'; // On macOS, gdu is installed as gdu-go to avoid conflict with coreutils
            } else if (this.platform === 'windows') {
                const gduUrl = 'https://github.com/dundee/gdu/releases/download/v5.31.0/gdu_windows_amd64.exe.zip';
                const gduZipPath = path.join(process.env.RUNNER_TEMP, 'gdu.zip');
                const gduExtractPath = path.join(process.env.RUNNER_TEMP, 'gdu_extracted');

                await exec.exec('powershell', ['-Command', `Invoke-WebRequest -Uri ${gduUrl} -OutFile ${gduZipPath}`]);
                await io.mkdirP(gduExtractPath);
                await exec.exec('powershell', ['-Command', `Expand-Archive -Path ${gduZipPath} -DestinationPath ${gduExtractPath}`]);

                const gduExePath = path.join(gduExtractPath, 'gdu_windows_amd64.exe');
                const finalGduPath = path.join(gduExtractPath, 'gdu.exe');
                await fs.rename(gduExePath, finalGduPath);

                core.addPath(gduExtractPath);
                this.gduCommand = 'gdu.exe';
            }
            console.log('✓ gdu installed successfully.');
            return true;
        } catch (e) {
            core.warning(`Failed to install gdu: ${e.message}`);
            return false;
        }
    }

    async _runAnalysisAndUpload(artifactName, scanPath) {
        const reportFile = `${artifactName}.json`;
        const reportPath = path.join(process.env.RUNNER_TEMP, reportFile);

        console.log(`\nRunning gdu scan on ${scanPath}...`);
        let gduError = '';
        const options = {
            ignoreReturnCode: true,
            listeners: {
                stderr: (data) => {
                    gduError += data.toString();
                }
            }
        };

        const exitCode = await exec.exec(this.gduCommand, ['-n', '-a', '-o', reportPath, scanPath], options);

        if (gduError) {
            core.warning(`gdu encountered errors while scanning ${scanPath}. The report may be incomplete.`);
            core.warning(gduError);
        }
        
        if (exitCode !== 0) {
            core.warning(`gdu exited with code ${exitCode}.`);
        }

        try {
            await this.artifact.uploadArtifact(artifactName, [reportPath], process.env.RUNNER_TEMP, {
                retentionDays: 1
            });
            console.log(`✓ Uploaded ${artifactName} artifact.`);
            await io.rmRF(reportPath);
        } catch (e) {
            core.warning(`Failed to upload artifact ${artifactName}: ${e.message}`);
        }
    }

    async analyze(stage) {
        console.log(`\n=== Disk Usage Analysis (${stage}) ===`);
        const installed = await this._installGdu();
        if (!installed) {
            console.log('Skipping disk analysis because gdu installation failed.');
            return;
        }

        if (this.platform === 'windows') {
            await this._runAnalysisAndUpload(`disk-usage-${stage}-${this.platform}-${this.arch}-C`, 'C:\\');
            await this._runAnalysisAndUpload(`disk-usage-${stage}-${this.platform}-${this.arch}-D`, 'D:\\');
        } else if (this.platform === 'linux' || this.platform === 'macos') {
            await this._runAnalysisAndUpload(`disk-usage-${stage}-${this.platform}-${this.arch}`, '/');
        }
    }
}

module.exports = { DiskAnalyzer };
