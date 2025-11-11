#!/usr/bin/env node
/**
 * Download and extract a (possibly encrypted) compressed archive volume from a GitHub artifact.
 *
 * Usage:
 *   node download-volume.js <volumeNum> <artifactName> <outputPath> <tempDir>
 *
 * Arguments:
 *   volumeNum    Number of the volume being downloaded (for logging/tracking)
 *   artifactName Name of the GitHub artifact containing the compressed file
 *   outputPath   Absolute or relative path to write the decompressed output
 *   tempDir      Directory to use for temporary download and processing
 *
 * Behavior:
 *   - Downloads the specified artifact containing either a .zst or .zst.gpg file.
 *   - If the file is encrypted (.zst.gpg), it decrypts using GPG and ARCHIVE_PASSWORD.
 *   - Decompresses the (possibly decrypted) .zst file to the given outputPath, using 2 threads.
 *   - Cleans up temp files afterward.
 */

const { DefaultArtifactClient } = require('@actions/artifact');
const { exec } = require('@actions/exec');
const fs = require('fs').promises;
const path = require('path');

/**
 * Downloads a compressed archive volume from a GitHub artifact, decrypts if needed, and decompresses it.
 * 
 * @param {number} volumeNum    - Volume number for logging
 * @param {string} artifactName - Name of the artifact to download
 * @param {string} outputPath   - Path to save decompressed file
 * @param {string} tempDir      - Temporary directory for processing
 * @returns {Promise<number>}   - 0 on success, 1 on error
 */
async function downloadAndDecompress(volumeNum, artifactName, outputPath, tempDir) {
    const artifact = new DefaultArtifactClient();
    const tempDownload = path.join(tempDir, `dl-${volumeNum}`);
    const password = process.env.ARCHIVE_PASSWORD;

    try {
        await fs.mkdir(tempDownload, { recursive: true });

        console.error(`[Download] Fetching ${artifactName}...`);
        const volumeInfo = await artifact.getArtifact(artifactName);
        await artifact.downloadArtifact(volumeInfo.artifact.id, { path: tempDownload });

        const files = await fs.readdir(tempDownload);

        // Prefer encrypted file (.zst.gpg), fallback to unencrypted (.zst)
        let downloadedFile = files.find(f => f.endsWith('.zst.gpg'));
        let isEncrypted = !!downloadedFile;

        if (!downloadedFile) {
            downloadedFile = files.find(f => f.endsWith('.zst'));
        }

        if (!downloadedFile) {
            throw new Error('No .zst or .zst.gpg file found in downloaded artifact');
        }

        let compressedPath = path.join(tempDownload, downloadedFile);

        // Decrypt if file is encrypted with GPG.
        if (isEncrypted) {
            if (!password) {
                throw new Error('Archive is encrypted but ARCHIVE_PASSWORD is not set');
            }

            console.error(`[Download] 🔒 Decrypting with GPG...`);
            const decryptedPath = compressedPath.replace('.gpg', '');

            // Password is passed via stdin using bash pipe
            await exec('bash', [
                '-c',
                `echo "$ARCHIVE_PASSWORD" | gpg --batch --yes --passphrase-fd 0 --decrypt --output "${decryptedPath}" "${compressedPath}"`
            ], {
                env: {
                    ...process.env,
                    ARCHIVE_PASSWORD: password
                }
            });

            await fs.unlink(compressedPath);
            compressedPath = decryptedPath;
            console.error(`[Download] ✓ Decrypted`);
        }

        // Decompress the .zst file to the requested output path
        console.error(`[Download] Decompressing to ${path.basename(outputPath)} (using 2 threads)...`);
        await exec('zstd', ['-d', '-T2', '--rm', compressedPath, '-o', outputPath]);

        console.error(`[Download] ✓ Volume ${volumeNum} ready`);

        // Remove temporary download directory
        await fs.rm(tempDownload, { recursive: true, force: true });

        return 0;
    } catch (e) {
        console.error(`[Download] Error: ${e.message}`);
        return 1;
    }
}

// ---- Input processing and invocation ----

const volumeNum = parseInt(process.argv[2]);
const artifactName = process.argv[3];
const outputPath = process.argv[4];
const tempDir = process.argv[5];

if (
    Number.isNaN(volumeNum) ||
    !artifactName ||
    !outputPath ||
    !tempDir
) {
    console.error('Usage: download-volume.js <volumeNum> <artifactName> <outputPath> <tempDir>');
    process.exit(1);
}

downloadAndDecompress(volumeNum, artifactName, outputPath, tempDir)
    .then(code => process.exit(code))
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

