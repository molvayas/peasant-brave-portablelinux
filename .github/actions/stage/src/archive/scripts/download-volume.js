#!/usr/bin/env node
/**
 * Download and decompress a volume artifact
 * 
 * Usage: node download-volume.js <volumeNum> <artifactName> <outputPath> <tempDir>
 * 
 * Arguments:
 *   volumeNum    - Volume number (for logging)
 *   artifactName - Name of the artifact to download
 *   outputPath   - Path to save decompressed file
 *   tempDir      - Temporary directory for download
 */

const {DefaultArtifactClient} = require('@actions/artifact');
const {exec} = require('@actions/exec');
const fs = require('fs').promises;
const path = require('path');

async function downloadAndDecompress(volumeNum, artifactName, outputPath, tempDir) {
    const artifact = new DefaultArtifactClient();
    const tempDownload = path.join(tempDir, `dl-${volumeNum}`);
    const password = process.env.ARCHIVE_PASSWORD;
    
    try {
        await fs.mkdir(tempDownload, {recursive: true});
        
        console.error(`[Download] Fetching ${artifactName}...`);
        const volumeInfo = await artifact.getArtifact(artifactName);
        await artifact.downloadArtifact(volumeInfo.artifact.id, {path: tempDownload});
        
        const files = await fs.readdir(tempDownload);
        
        // Check for encrypted file first (.zst.gpg), then unencrypted (.zst)
        let downloadedFile = files.find(f => f.endsWith('.zst.gpg'));
        let isEncrypted = !!downloadedFile;
        
        if (!downloadedFile) {
            downloadedFile = files.find(f => f.endsWith('.zst'));
        }
        
        if (!downloadedFile) {
            throw new Error('No .zst or .zst.gpg file found in downloaded artifact');
        }
        
        let compressedPath = path.join(tempDownload, downloadedFile);
        
        // Decrypt if file is encrypted
        if (isEncrypted) {
            if (!password) {
                throw new Error('Archive is encrypted but ARCHIVE_PASSWORD is not set');
            }
            
            console.error(`[Download] 🔒 Decrypting with GPG...`);
            const decryptedPath = compressedPath.replace('.gpg', '');
            
            // Use bash to handle password piping
            await exec('bash', ['-c', `echo "$ARCHIVE_PASSWORD" | gpg --batch --yes --passphrase-fd 0 --decrypt --output "${decryptedPath}" "${compressedPath}"`], {
                env: {
                    ...process.env,
                    ARCHIVE_PASSWORD: password
                }
            });
            
            await fs.unlink(compressedPath);
            compressedPath = decryptedPath;
            console.error(`[Download] ✓ Decrypted`);
        }
        
        console.error(`[Download] Decompressing to ${path.basename(outputPath)} (using 2 threads)...`);
        await exec('zstd', ['-d', '-T2', '--rm', compressedPath, '-o', outputPath]);
        
        console.error(`[Download] ✓ Volume ${volumeNum} ready`);
        
        await fs.rm(tempDownload, {recursive: true, force: true});
        
        return 0;
    } catch (e) {
        console.error(`[Download] Error: ${e.message}`);
        return 1;
    }
}

const volumeNum = parseInt(process.argv[2]);
const artifactName = process.argv[3];
const outputPath = process.argv[4];
const tempDir = process.argv[5];

if (!volumeNum || !artifactName || !outputPath || !tempDir) {
    console.error('Usage: download-volume.js <volumeNum> <artifactName> <outputPath> <tempDir>');
    process.exit(1);
}

downloadAndDecompress(volumeNum, artifactName, outputPath, tempDir)
    .then(code => process.exit(code))
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

