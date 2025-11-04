# Brave Release Builds - Setup Guide

This guide explains how to configure Release builds (official builds) with proper secret management.

## Table of Contents

- [Component vs Release Builds](#component-vs-release-builds)
- [Setting Up GitHub Secrets](#setting-up-github-secrets)
- [Creating the .env File](#creating-the-env-file)
- [Running Release Builds](#running-release-builds)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

## Component vs Release Builds

### Component Build (Default)
- **Faster** - Uses component build mode
- **No secrets required** - Works without `.env` file
- **For testing** - Suitable for verifying builds work
- **Larger binaries** - Each component is a separate library
- **Default behavior** - No special configuration needed

### Release Build
- **Slower** - Full optimized release build
- **Requires secrets** - Needs `.env` file with API keys
- **For production** - Official Brave builds
- **Optimized binaries** - Smaller, faster, production-ready
- **Needs configuration** - Requires GitHub secrets setup

## Setting Up GitHub Secrets

### 1. Create Your .env File Locally

Based on the [Brave Build Configuration](https://github.com/brave/brave-browser/wiki/Build-configuration), create a `.env` file with your secrets.

**Minimum Required for Release Builds:**

```bash
# Core Services (Required)
brave_services_key=your_key_here
brave_services_key_id=your_key_id_here

# Google API (Required)
google_default_client_id=your_client_id
google_default_client_secret=your_client_secret
brave_google_api_key=your_api_key
brave_google_api_endpoint=https://...

# Brave-specific endpoints
brave_stats_api_key=your_stats_key
brave_stats_updater_url=https://...
brave_sync_endpoint=https://...
brave_variations_server_url=https://...

# Other required keys
brave_infura_project_id=your_infura_id
brave_referrals_api_key=your_referrals_key
brave_zero_ex_api_key=your_zero_ex_key

# Platform-specific (if building for that platform)
# See full list in brave-browser.wiki/Build-configuration.md
```

**Important:** You can use dummy values for testing, but production builds need real API keys from Brave.

### 2. Add Secret to GitHub

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `BRAVE_ENV_CONFIG`
5. Value: Paste the **entire contents** of your `.env` file
6. Click **Add secret**

### 3. Verify Secret is Set

The secret `BRAVE_ENV_CONFIG` should now appear in your repository secrets list (value hidden).

## Creating the .env File

### Full Example

Here's a complete example with all common secrets:

```bash
# ============================================================================
# Core Brave Services
# ============================================================================
brave_services_key=your_services_key_here
brave_services_key_id=your_services_key_id_here
brave_pref_hash_seed=your_pref_hash_seed

# ============================================================================
# Google Services
# ============================================================================
google_default_client_id=your_google_client_id
google_default_client_secret=your_google_client_secret
brave_google_api_key=your_google_api_key
brave_google_api_endpoint=https://brave-google-api.brave.com

# ============================================================================
# Brave APIs
# ============================================================================
brave_stats_api_key=your_stats_api_key
brave_stats_updater_url=https://laptop-updates.brave.com
brave_sync_endpoint=https://sync-v2.brave.com
brave_variations_server_url=https://variations.brave.com/seed
brave_referrals_api_key=your_referrals_api_key

# ============================================================================
# Crypto/Web3 Services
# ============================================================================
brave_infura_project_id=your_infura_project_id
brave_zero_ex_api_key=your_zero_ex_api_key
binance_client_id=your_binance_client_id

# ============================================================================
# Rewards & Wallet Partners
# ============================================================================
# Uphold
uphold_production_api_url=https://api.uphold.com
uphold_production_client_id=your_uphold_client_id
uphold_production_client_secret=your_uphold_client_secret
uphold_production_fee_address=your_fee_address
uphold_production_oauth_url=https://uphold.com/authorize

# Gemini
gemini_production_api_url=https://api.gemini.com
gemini_production_client_id=your_gemini_client_id
gemini_production_client_secret=your_gemini_client_secret
gemini_production_fee_address=your_fee_address
gemini_production_oauth_url=https://exchange.gemini.com/auth

# Bitflyer
bitflyer_production_url=https://bitflyer.com
bitflyer_production_client_id=your_bitflyer_client_id
bitflyer_production_client_secret=your_bitflyer_client_secret
bitflyer_production_fee_address=your_fee_address

# Zebpay
zebpay_production_api_url=https://www.zebapi.com
zebpay_production_client_id=your_zebpay_client_id
zebpay_production_client_secret=your_zebpay_client_secret
zebpay_production_oauth_url=https://www.zebpay.com/oauth

# ============================================================================
# AI Features
# ============================================================================
brave_ai_chat_endpoint=https://api.brave.com/ai
service_key_aichat=your_ai_chat_key
service_key_stt=your_speech_to_text_key

# ============================================================================
# Security & Privacy
# ============================================================================
safebrowsing_api_endpoint=https://safebrowsing.brave.com
email_aliases_api_key=your_email_aliases_key
sardine_client_id=your_sardine_client_id
sardine_client_secret=your_sardine_client_secret

# ============================================================================
# Updater
# ============================================================================
updater_prod_endpoint=https://updates.brave.com
updater_dev_endpoint=https://updates-dev.brave.com

# ============================================================================
# Rewards Grant Endpoints
# ============================================================================
rewards_grant_prod_endpoint=https://grant.rewards.brave.com
rewards_grant_staging_endpoint=https://grant.rewards.bravesoftware.com
rewards_grant_dev_endpoint=https://grant.rewards-dev.brave.com

# ============================================================================
# Build Flags
# ============================================================================
is_brave_release_build=1
brave_p3a_enabled=true

# ============================================================================
# Platform-Specific Secrets (if needed)
# ============================================================================
# macOS (for code signing)
# notary_user=your_apple_id@example.com
# notary_password=your_app_specific_password
# mac_signing_identifier=Developer ID Application: Your Name (TEAMID)
# sparkle_eddsa_private_key=your_sparkle_private_key
# sparkle_eddsa_public_key=your_sparkle_public_key

# Android (for signing)
# brave_android_keystore_path=/path/to/keystore
# brave_android_keystore_name=your_key_alias
# brave_android_keystore_password=your_keystore_password
# brave_android_key_password=your_key_password
# brave_safebrowsing_api_key=your_safebrowsing_key
# brave_android_developer_options_code=your_dev_options_code
```

### Using Dummy Values for Testing

For testing Release builds without real API keys, you can use dummy values:

```bash
# Minimal dummy .env for testing Release builds
brave_services_key=dummy_key
brave_services_key_id=dummy_key_id
google_default_client_id=dummy_client_id
google_default_client_secret=dummy_secret
brave_google_api_key=dummy_api_key
brave_google_api_endpoint=https://example.com
brave_stats_api_key=dummy_stats_key
brave_stats_updater_url=https://example.com
brave_sync_endpoint=https://example.com
brave_variations_server_url=https://example.com
brave_infura_project_id=dummy_infura_id
brave_referrals_api_key=dummy_referrals_key
brave_zero_ex_api_key=dummy_zero_ex_key
```

⚠️ **Warning:** Builds with dummy values will compile but may not function correctly for features requiring valid API keys.

## Running Release Builds

### Via GitHub Actions UI

1. Go to **Actions** tab in your repository
2. Select **Build Brave Browser** workflow
3. Click **Run workflow**
4. Configure your build:
   - ✅ Select platforms to build (Linux x64, macOS x64, etc.)
   - **Build type**: Select **Release** (instead of Component)
   - Configure publishing options if needed
5. Click **Run workflow**

### Build Type Selection

The workflow now has a **Build type** dropdown:
- **Component** (default) - Fast development builds, no secrets needed
- **Release** - Production builds, requires `BRAVE_ENV_CONFIG` secret

## Security

### How .env Files Are Handled

The build system implements **Option 1: Ephemeral .env files** for maximum security:

1. **Creation**: `.env` file is created from `BRAVE_ENV_CONFIG` secret at the START of each stage
2. **Location**: Created at `src/brave/.env` (brave-core directory)
3. **Usage**: Used during `npm run build Release` command
4. **Deletion**: Automatically **deleted BEFORE creating checkpoint artifacts**
5. **Restoration**: Recreated from secrets when next stage resumes

### Security Features

✅ **Secrets never stored in artifacts**
- `.env` file is deleted before checkpoint creation
- Intermediate build artifacts don't contain secrets
- Each stage recreates `.env` from GitHub Secrets

✅ **Secrets only in GitHub**
- Stored securely in GitHub Secrets
- Never committed to git (`.env` in `.gitignore`)
- Not visible in logs or artifacts

✅ **Automatic cleanup**
- No manual intervention needed
- Secrets removed automatically before checkpointing
- Fresh secrets loaded from GitHub at each stage

### Best Practices

1. **Never commit .env files**
   ```bash
   # .gitignore already includes
   .env
   ```

2. **Rotate secrets regularly**
   - Update `BRAVE_ENV_CONFIG` secret in GitHub Settings
   - Next build will use new secrets

3. **Use different secrets for different builds**
   - Production builds: Real API keys
   - Test builds: Dummy values or Component builds

4. **Audit secret access**
   - Review who has access to repository secrets
   - Use GitHub's secret audit logs

## Troubleshooting

### Build Fails with "API key missing"

**Problem**: Release build fails with errors about missing API keys.

**Solution**:
1. Verify `BRAVE_ENV_CONFIG` secret is set in repository
2. Check that `.env` file contents are complete
3. Ensure no syntax errors in `.env` file
4. Try Component build first to verify build system works

### ".env file not found" error

**Problem**: Build can't find `.env` file.

**Solution**:
1. Verify `BRAVE_ENV_CONFIG` secret exists and is not empty
2. Check workflow logs for "Creating .env File" message
3. Ensure `build_type` is passed correctly in workflow

### Component build works but Release fails

**Problem**: Component builds succeed, but Release builds fail.

**Solution**:
1. Release builds are stricter and require more dependencies
2. Check that ALL required API keys are present
3. Try with dummy values first to isolate secret issues
4. Review Brave build logs for specific missing keys

### Secrets appearing in logs

**Problem**: Worried about secrets in build logs.

**Solution**:
- GitHub Actions automatically masks secret values in logs
- `.env` file contents are never printed
- Build system only logs that .env was created/deleted
- Double-check logs don't contain actual API keys

### Build artifacts contain .env file

**Problem**: Concerned .env might be in artifacts.

**Solution**:
- This is prevented by design
- `.env` is deleted BEFORE checkpoint creation
- You can verify by downloading and inspecting artifacts
- Each artifact is created AFTER `.env` deletion

## Testing Your Setup

### Test Workflow

1. **First**: Run a Component build (no secrets needed)
   ```
   Build type: Component
   ```
   - Should complete successfully
   - Verify basic build system works

2. **Second**: Run a Release build with dummy secrets
   ```
   Build type: Release
   ```
   - Set `BRAVE_ENV_CONFIG` with dummy values
   - Should compile but may have runtime issues

3. **Third**: Run a Release build with real secrets
   ```
   Build type: Release
   ```
   - Set `BRAVE_ENV_CONFIG` with real API keys
   - Should produce fully functional browser

### Verification Checklist

- [ ] `BRAVE_ENV_CONFIG` secret is set in GitHub
- [ ] `.env` file has all required keys for your platform
- [ ] Component build completes successfully
- [ ] Release build starts without errors
- [ ] Workflow logs show ".env file created"
- [ ] Workflow logs show ".env file deleted" before checkpoint
- [ ] Downloaded artifacts don't contain `.env` file
- [ ] Built browser launches and runs

## Additional Notes

### Per-Platform Secrets

Different platforms may need additional secrets:

- **macOS**: Code signing certificates (`mac_signing_identifier`, `notary_user`, etc.)
- **Windows**: Authenticode signing (environment variables, not in `.env`)
- **Android**: Keystore paths and passwords
- **Linux**: Generally no platform-specific secrets needed

### CI/CD Integration

For automated builds:

1. Set `BRAVE_ENV_CONFIG` as organization or repository secret
2. Use `workflow_dispatch` to trigger builds programmatically
3. Consider separate secrets for different environments (staging/production)

### Getting Real API Keys

**For Brave Contributors:**
- Contact Brave DevOps team for access to official API keys
- See internal documentation for key management

**For External Builders:**
- Component builds work without keys
- Many features will be disabled without real keys
- Consider using dummy values for testing only

## Support

- [Brave Build Wiki](https://github.com/brave/brave-browser/wiki)
- [Build Configuration](https://github.com/brave/brave-browser/wiki/Build-configuration)
- [Development Environment](https://github.com/brave/brave-browser/wiki/Linux-Development-Environment)

---

**Last Updated**: December 2024
**Compatible With**: Brave v1.70+

