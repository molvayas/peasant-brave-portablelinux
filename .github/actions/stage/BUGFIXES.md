# Bug Fixes Summary

## Bugs Found and Fixed

### 1. ✅ Missing Source Files (`.gitignore` issue)
**Error**: `Cannot find module './build/factory'`

**Cause**: The `.gitignore` had `build/` which prevented `src/build/` directory from being committed.

**Fix**: Changed `.gitignore` from `build/` to `/build/` to only ignore the root build directory, not `src/build/`.

```diff
- build/
+ /build/
+ brave-build/
```

**Files changed**: `.gitignore`

---

### 2. ✅ Timeout Calculation Bug
**Issue**: `jobStartTime` was set in builder constructor instead of at the very beginning of the action.

**Impact**: If there was work between builder creation and `runBuild()`, timeout would be incorrectly calculated.

**Fix**: Moved `jobStartTime` to orchestrator constructor and explicitly passed to builder:

```javascript
// In orchestrator.js:
constructor(options) {
    this.jobStartTime = Date.now();  // ✅ Set at top
    this.builder = createBuilder(...);
    this.builder.jobStartTime = this.jobStartTime;  // ✅ Pass explicitly
}

// In linux.js:
constructor(braveVersion, arch) {
    this.jobStartTime = null;  // ✅ Will be set by orchestrator
}

async runBuild() {
    if (!this.jobStartTime) {  // ✅ Validate it was set
        throw new Error('jobStartTime not set!');
    }
    // Calculate timeout...
}
```

**Files changed**: 
- `src/orchestrator.js`
- `src/build/linux.js`
- `src/build/macos.js`
- `src/build/windows.js`

**Documentation**: `BUGFIX_TIMEOUT.md`

---

### 3. ✅ Script Path Resolution Bug
**Error**: `Cannot find module '/home/runner/brave-build/scripts/upload-volume.js'`

**Cause**: Bash scripts used relative paths that didn't work at runtime:
```bash
node "${TEMP_DIR}/../scripts/upload-volume.js"
# Becomes: /home/runner/brave-build/tar-temp/../scripts/upload-volume.js
# = /home/runner/brave-build/scripts/upload-volume.js  ❌ Wrong path!
```

**Actual location**: `.github/actions/stage/src/archive/scripts/upload-volume.js`

**Fix**: Pass `SCRIPTS_DIR` as an argument to all scripts:

```javascript
// In multi-volume.js:
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

// Wrapper script:
exec "${actualScriptPath}" "${tempDir}" "${artifactName}" ... "${SCRIPTS_DIR}"
```

```bash
# In next-volume.sh:
SCRIPTS_DIR="$5"  # Accept as argument
node "${SCRIPTS_DIR}/upload-volume.js"  # Use absolute path ✅
```

**Files changed**:
- `src/archive/multi-volume.js` - Pass SCRIPTS_DIR in wrapper
- `src/archive/scripts/next-volume.sh` - Accept SCRIPTS_DIR argument
- `src/archive/scripts/next-volume-extract.sh` - Accept SCRIPTS_DIR argument

---

## Testing Status

| Bug | Status | Verification |
|-----|--------|--------------|
| **1. Missing files** | ✅ Fixed | Files now in git |
| **2. Timeout calc** | ✅ Fixed | Logic validated, needs runtime test |
| **3. Script paths** | ✅ Fixed | Syntax valid, needs runtime test |

## Runtime Verification Needed

When the action runs next, verify:

1. **Files load**: No "Cannot find module" errors
2. **Timeout calculation**: Check logs show:
   ```
   Time elapsed in job: X.XX hours
   Remaining time calculated: Y.YY hours
   Final timeout: ZZZ minutes
   ```
3. **Script execution**: Archive creation completes without path errors
4. **Upload success**: Volumes upload successfully

## What to Watch For

### Success Indicators ✅
- ✓ No module loading errors
- ✓ Timeout shows elapsed time > 0
- ✓ Volumes compress and upload
- ✓ Manifest created
- ✓ Checkpoint artifact ready

### Failure Indicators ❌
- ✗ "Cannot find module" errors
- ✗ Timeout = full 300 minutes (should be less)
- ✗ Script path errors
- ✗ Upload failures

## Rollback Plan

If issues persist:

1. **Quick fix**: Point to backup
   ```yaml
   runs:
     using: 'node20'
     main: 'index.js.backup'
   ```

2. **Full rollback**:
   ```bash
   git revert HEAD
   ```

## Summary

Three critical bugs were found and fixed:
1. **Gitignore** preventing source files from being committed
2. **Timeout** not accounting for time before build
3. **Script paths** using incorrect relative paths

All bugs have been fixed and validated syntactically. Runtime testing is needed to confirm everything works end-to-end.

