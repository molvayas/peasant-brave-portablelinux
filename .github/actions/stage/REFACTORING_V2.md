# Refactoring V2: Dedicated Scripts

## What Changed

During the initial refactoring, bash scripts for volume processing were **dynamically generated** using JavaScript template literals. This worked but had several issues:

### Problems with Dynamic Generation

1. **Hard to Read**: Bash code embedded in JavaScript strings
2. **Hard to Test**: Can't test scripts independently
3. **Syntax Checking**: Can't use `bash -n` to check syntax
4. **Escaping Issues**: Complex with quotes, backticks, and variables
5. **Hard to Debug**: Must read through JavaScript to understand bash
6. **Large File**: `multi-volume.js` was 670 lines, mostly script generation

### Solution: Dedicated Script Files

Created actual `.sh` and `.js` files in `src/archive/scripts/`:

```
src/archive/
├── multi-volume.js          # 300 lines (down from 670!)
└── scripts/
    ├── next-volume.sh       # Bash script for volume creation
    ├── upload-volume.js     # Node script for uploads
    ├── next-volume-extract.sh  # Bash script for extraction
    └── download-volume.js   # Node script for downloads
```

## Benefits

### ✅ Much Cleaner Code

**Before** (670 lines with template literals):
```javascript
function _generateVolumeScript(tempDir, artifactName, processedVolumesFile) {
    return `#!/bin/bash
# 100+ lines of bash in a JavaScript string
# Complex escaping: \${variable}, \`commands\`, etc.
...`;
}
```

**After** (300 lines, delegating to scripts):
```javascript
async function _setupVolumeProcessing(tempDir, artifactName, processedVolumesFile) {
    const scriptPath = path.join(SCRIPTS_DIR, 'next-volume.sh');
    // Pass arguments to the script
    ...
}
```

### ✅ Easier to Maintain

- **Edit bash in bash files** (with proper syntax highlighting)
- **Edit JavaScript in JS files** (with proper linting)
- **No mixing** of languages in strings

### ✅ Testable

```bash
# Can test scripts independently:
cd src/archive/scripts
bash -n next-volume.sh  # Syntax check
./next-volume.sh args...  # Test execution
```

### ✅ Better Developer Experience

- IDEs provide proper syntax highlighting for dedicated files
- Version control diffs are cleaner
- Can document scripts with comments in their native language
- Easier for new developers to understand

## File Size Comparison

| File | Before | After | Change |
|------|--------|-------|--------|
| `multi-volume.js` | 670 lines | 300 lines | -55% |
| Total lines | 670 | 300 + 4 scripts | More modular |

## How It Works

### Archive Creation

1. `multi-volume.js` creates a **wrapper script** that calls `next-volume.sh` with arguments
2. tar calls the wrapper script between volumes
3. `next-volume.sh` compresses the volume and calls `upload-volume.js`
4. Process repeats for each volume

### Archive Extraction

1. `multi-volume.js` creates a **wrapper script** that calls `next-volume-extract.sh` with arguments
2. tar calls the wrapper script when it needs a volume
3. `next-volume-extract.sh` calls `download-volume.js` to fetch and decompress
4. Process repeats for each volume

## Arguments vs Environment Variables

Scripts receive configuration via **command-line arguments**:

```bash
# next-volume.sh receives:
./next-volume.sh "$TEMP_DIR" "$ARTIFACT_NAME" "$PROCESSED_VOLUMES_FILE" "$COMPRESSION_LEVEL"
```

This is cleaner than environment variables because:
- Explicit and visible in process list
- No global state pollution
- Easy to test with different values

## Migration Notes

No changes to the public API! The refactoring is internal:
- Same function signatures
- Same behavior
- Same outputs

The only difference is **how** scripts are managed internally.

## What's Still Dynamic

The **wrapper scripts** are still generated dynamically, but they're tiny:

```bash
#!/bin/bash
# Just 3 lines: source env and call the actual script
exec "/path/to/actual/script.sh" "$ARG1" "$ARG2" ...
```

This is acceptable because:
- Very simple (no complex logic)
- Just argument passing
- Hard to get wrong

## Testing

Verify bash scripts have valid syntax:
```bash
cd src/archive/scripts
bash -n next-volume.sh
bash -n next-volume-extract.sh
# ✓ Both pass
```

Verify scripts are executable:
```bash
ls -la src/archive/scripts/
# All should have +x permission
```

## Conclusion

This v2 refactoring makes the codebase even more maintainable:
- 55% smaller multi-volume.js
- Dedicated, testable scripts
- Better developer experience
- Same functionality

**Status**: ✅ Complete and tested (syntax validated)

