/**
 * Disk Usage Analysis Utility using gdu (Go Disk Usage)
 *
 * This utility provides detailed disk usage analysis during different build stages
 * to help track storage consumption and identify disk space issues. It uses the
 * fast gdu tool to generate JSON reports that are uploaded as GitHub artifacts.
 *
 * Key features:
 * - Cross-platform gdu installation (Linux/macOS/Windows)
 * - Automatic artifact upload for build analysis
 * - Platform-specific disk scanning (C:/D: drives on Windows, root on Unix)
 * - Graceful fallback when gdu installation fails
 *
 * Used in build orchestration to monitor disk usage between stages:
 * - post-init: After repository setup and dependency installation
 * - post-build: After compilation to track build artifact sizes
 */

const core = require('@actions/core');
const exec = require('@actions/exec');
const { DefaultArtifactClient } = require('@actions/artifact');
const fs = require('fs').promises;
const path = require('path');
const io = require('@actions/io');
const { getPlatformConfig } = require('../config/constants');

class DiskAnalyzer {
    /**
     * Initialize disk analyzer for a specific platform and architecture
     *
     * @param {string} platform - Target platform (linux, macos, windows)
     * @param {string} arch - Target architecture (x64, arm64, x86)
     */
    constructor(platform, arch) {
        this.platform = platform;
        this.arch = arch;
        this.artifact = new DefaultArtifactClient();

        // Default gdu command (may be overridden during installation)
        this.gduCommand = 'gdu';

        // Check if gdu is enabled for this platform (disabled on Windows by default)
        const platformConfig = getPlatformConfig(platform);
        this.enableGdu = platformConfig.enableGdu !== false; // Default to true if not specified
    }

    /**
     * Install gdu (Go Disk Usage) tool for the current platform
     *
     * gdu is a fast disk usage analyzer written in Go. This method handles
     * platform-specific installation:
     * - Linux: apt-get install gdu
     * - macOS: brew install gdu (installs as gdu-go)
     * - Windows: Download pre-built binary from GitHub releases
     *
     * @private
     * @returns {Promise<boolean>} true if installation successful, false otherwise
     */
    async _installGdu() {
        console.log(`\nInstalling gdu for ${this.platform}...`);
        try {
            if (this.platform === 'linux') {
                // Use apt package manager for Ubuntu/Debian
                await exec.exec('sudo', ['apt-get', 'update']);
                await exec.exec('sudo', ['apt-get', 'install', '-y', 'gdu']);
            } else if (this.platform === 'macos') {
                // Use Homebrew, which installs gdu as 'gdu-go' to avoid conflicts
                await exec.exec('brew', ['install', 'gdu']);
                this.gduCommand = 'gdu-go'; // Override default command name
            } else if (this.platform === 'windows') {
                // Download and extract pre-built Windows binary from GitHub releases
                const gduUrl = 'https://github.com/dundee/gdu/releases/download/v5.31.0/gdu_windows_amd64.exe.zip';
                const gduZipPath = path.join(process.env.RUNNER_TEMP, 'gdu.zip');
                const gduExtractPath = path.join(process.env.RUNNER_TEMP, 'gdu_extracted');

                // Download the zip file using PowerShell
                await exec.exec('powershell', ['-Command', `Invoke-WebRequest -Uri ${gduUrl} -OutFile ${gduZipPath}`]);

                // Extract the archive
                await io.mkdirP(gduExtractPath);
                await exec.exec('powershell', ['-Command', `Expand-Archive -Path ${gduZipPath} -DestinationPath ${gduExtractPath}`]);

                // Rename the executable and add to PATH
                const gduExePath = path.join(gduExtractPath, 'gdu_windows_amd64.exe');
                const finalGduPath = path.join(gduExtractPath, 'gdu.exe');
                await fs.rename(gduExePath, finalGduPath);

                // Add the extraction directory to PATH
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

    /**
     * Run disk usage analysis and upload the results as a GitHub artifact
     *
     * This method performs the actual disk scanning using gdu and uploads the
     * JSON report as a GitHub artifact for later analysis. The report contains
     * detailed file/directory size information that can be visualized.
     *
     * gdu flags used:
     * -n: Non-interactive mode
     * -a: Show apparent size instead of disk usage
     * -o: Output file path
     *
     * @private
     * @param {string} artifactName - Name for the GitHub artifact
     * @param {string} scanPath - Filesystem path to scan (e.g., '/', 'C:\', 'D:\')
     */
    async _runAnalysisAndUpload(artifactName, scanPath) {
        const reportFile = `${artifactName}.json`;
        const reportPath = path.join(process.env.RUNNER_TEMP, reportFile);

        console.log(`\nRunning gdu scan on ${scanPath}...`);

        // Capture stderr output to detect gdu warnings/errors
        let gduError = '';
        const options = {
            ignoreReturnCode: true,
            listeners: {
                stderr: (data) => {
                    gduError += data.toString();
                }
            }
        };

        // Run gdu scan: -n (non-interactive), -a (apparent size), -o (output file), scanPath
        const exitCode = await exec.exec(this.gduCommand, ['-n', '-a', '-o', reportPath, scanPath], options);

        // Report any gdu errors/warnings but don't fail the build
        if (gduError) {
            core.warning(`gdu encountered errors while scanning ${scanPath}. The report may be incomplete.`);
            core.warning(gduError);
        }

        if (exitCode !== 0) {
            core.warning(`gdu exited with code ${exitCode}.`);
        }

        // Upload the JSON report as a GitHub artifact
        try {
            await this.artifact.uploadArtifact(artifactName, [reportPath], process.env.RUNNER_TEMP, {
                retentionDays: 1  // Keep disk analysis artifacts for 1 day only
            });
            console.log(`✓ Uploaded ${artifactName} artifact.`);
            // Clean up the temporary report file
            await io.rmRF(reportPath);
        } catch (e) {
            core.warning(`Failed to upload artifact ${artifactName}: ${e.message}`);
        }
    }

    /**
     * Perform disk usage analysis for the specified build stage
     *
     * This is the main public method that coordinates the entire disk analysis process.
     * It installs gdu if needed, then scans the appropriate filesystem locations and
     * uploads the results as GitHub artifacts.
     *
     * Called by the build orchestrator after major build stages:
     * - 'post-init': After repository setup and npm dependencies
     * - 'post-build': After compilation to measure build output size
     *
     * @param {string} stage - Build stage identifier (e.g., 'post-init', 'post-build')
     */
    async analyze(stage) {
        console.log(`\n=== Disk Usage Analysis (${stage}) ===`);

        // Check if gdu is enabled for this platform (disabled on Windows by default)
        if (!this.enableGdu) {
            console.log(`Skipping disk analysis: gdu is disabled for ${this.platform} platform.`);
            return;
        }

        // Install gdu if not already available
        const installed = await this._installGdu();
        if (!installed) {
            console.log('Skipping disk analysis because gdu installation failed.');
            return;
        }

        // Platform-specific disk scanning:
        // - Windows: Scan both C: (system) and D: (build workspace) drives separately
        // - Linux/macOS: Scan root filesystem (/) which includes all mounted drives
        if (this.platform === 'windows') {
            await this._runAnalysisAndUpload(`disk-usage-${stage}-${this.platform}-${this.arch}-C`, 'C:\\');
            await this._runAnalysisAndUpload(`disk-usage-${stage}-${this.platform}-${this.arch}-D`, 'D:\\');
        } else if (this.platform === 'linux' || this.platform === 'macos') {
            await this._runAnalysisAndUpload(`disk-usage-${stage}-${this.platform}-${this.arch}`, '/');
        }
    }
}

module.exports = { DiskAnalyzer };
