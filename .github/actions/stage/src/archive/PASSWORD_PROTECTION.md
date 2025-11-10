# Password-Protected Archive Feature

## Overview

The archive module now supports password-protected compression for build artifacts. This adds an extra layer of security when transferring build state between GitHub Actions jobs.

## Security Features

### Windows (7z)
- **Encryption**: AES-256 (built into 7z)
- **Header Encryption**: File names and structure are hidden (`-mhe=on`)
- **Compression**: LZMA2 with password protection

### Linux/macOS (tar + zstd + GPG)
- **Encryption**: AES-256 via GPG symmetric encryption
- **Compression**: Zstandard (zstd) followed by GPG encryption
- **Format**: `.tar` → `.zst` → `.zst.gpg`

## How to Enable

### 1. Create a GitHub Secret

1. Go to your repository settings
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `ARCHIVE_PASSWORD`
5. Value: Your strong password (recommend 32+ random characters)
6. Click **Add secret**

**Important**: If you have multiple repositories that share artifacts, you must set the same secret in ALL of them.

### 2. Update Your Workflow

Add the secret as an environment variable in any step that creates or extracts archives:

```yaml
jobs:
  build:
    steps:
      - name: Create Checkpoint
        env:
          ARCHIVE_PASSWORD: ${{ secrets.ARCHIVE_PASSWORD }}
        # ... rest of step
      
      - name: Restore Checkpoint
        env:
          ARCHIVE_PASSWORD: ${{ secrets.ARCHIVE_PASSWORD }}
        # ... rest of step
```

### Example Workflow

```yaml
name: Build with Password-Protected Artifacts

on:
  push:
    branches: [main]

jobs:
  build-stage-1:
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      
      - name: Build
        run: |
          # Your build commands
          
      - name: Create Checkpoint
        env:
          ARCHIVE_PASSWORD: ${{ secrets.ARCHIVE_PASSWORD }}
        uses: ./.github/actions/stage
        with:
          stage: checkpoint
          # ... other inputs

  build-stage-2:
    needs: build-stage-1
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      
      - name: Restore Checkpoint
        env:
          ARCHIVE_PASSWORD: ${{ secrets.ARCHIVE_PASSWORD }}
        uses: ./.github/actions/stage
        with:
          stage: restore
          # ... other inputs
      
      - name: Continue Build
        run: |
          # Your build commands
```

## Backward Compatibility

The password protection is **optional and backward compatible**:

- ✅ **With `ARCHIVE_PASSWORD` set**: Archives are encrypted
- ✅ **Without `ARCHIVE_PASSWORD`**: Archives work as before (unencrypted)

## Security Considerations

### ✅ Benefits

1. **GitHub Secrets are encrypted at rest** and only exposed during workflow execution
2. **Logs are automatically masked** - GitHub redacts secret values from logs
3. **Additional protection** - Even if someone gains access to your artifact storage, they cannot extract the contents
4. **No performance overhead** - Encryption happens during compression

### ⚠️ Important Notes

1. **Consistent Secret**: All jobs that share artifacts must use the SAME password
2. **Secret Management**: Store the password securely; if lost, encrypted artifacts cannot be recovered
3. **Cross-Repository**: If artifacts are shared between repos, set the same secret in all repos
4. **Runner Environment**: The password is exposed in the runner's environment during execution

### 🔒 Best Practices

1. Use a **strong, random password** (32+ characters recommended)
2. Use a **password generator** or `openssl rand -base64 32`
3. **Rotate passwords periodically** if required by your security policy
4. **Limit repository access** to trusted contributors only
5. **Monitor workflow runs** for unexpected behavior

## How It Works

### Compression Flow (Windows)

```
Files → 7z archive (AES-256 encrypted) → Upload to artifacts
```

### Compression Flow (Linux/macOS)

```
Files → tar archive → zstd compression → GPG encryption (AES-256) → Upload to artifacts
```

### Extraction Flow (Windows)

```
Download artifact → 7z extract (with password) → Files
```

### Extraction Flow (Linux/macOS)

```
Download artifact → GPG decrypt (with password) → zstd decompress → tar extract → Files
```

## Logging

The system provides clear logging about encryption status:

**When password is set:**
```
🔒 Password protection: ENABLED
```

**When password is not set:**
```
⚠️  Password protection: DISABLED (no ARCHIVE_PASSWORD env var)
```

## Troubleshooting

### Error: "Archive is encrypted but ARCHIVE_PASSWORD is not set"

**Cause**: Trying to extract an encrypted archive without providing the password.

**Solution**: Add the `ARCHIVE_PASSWORD` environment variable to your workflow step.

### Error: "gpg is not installed"

**Cause**: GPG is not available on the runner.

**Solution**: GPG is pre-installed on all GitHub-hosted runners. If using self-hosted runners, install GPG:
- Ubuntu/Debian: `sudo apt-get install gnupg`
- macOS: `brew install gnupg`
- Windows: 7z has built-in encryption (no GPG needed)

### Error: Wrong password / decryption failed

**Cause**: The password used for extraction doesn't match the one used for compression.

**Solution**: Ensure the `ARCHIVE_PASSWORD` secret is the same across all jobs and repositories.

### Performance Impact

Encryption adds minimal overhead:
- **7z (Windows)**: ~2-5% slower (encryption integrated with compression)
- **GPG (Linux/macOS)**: ~5-10% slower (separate encryption step after compression)

The trade-off is worthwhile for sensitive build artifacts.

## Example: Generate Strong Password

```bash
# Generate a 32-character base64 password
openssl rand -base64 32

# Generate a 64-character hex password
openssl rand -hex 32
```

Copy the output and use it as your `ARCHIVE_PASSWORD` secret.

## Migration Guide

### To Enable Password Protection

1. Generate a strong password
2. Add it as a repository secret named `ARCHIVE_PASSWORD`
3. Update all workflow steps that create/extract archives to include the secret
4. Test with a small build first

### To Disable Password Protection

1. Remove the `ARCHIVE_PASSWORD` environment variable from workflow steps
2. (Optional) Delete the secret from repository settings

Note: Existing encrypted archives will require the password to extract. Archive new checkpoints without the password if you want to transition away.

## Support

If you encounter issues:
1. Check that the secret is correctly named `ARCHIVE_PASSWORD`
2. Verify the secret is set in all relevant repositories
3. Review workflow logs for specific error messages
4. Ensure the password is the same across all jobs in the workflow

