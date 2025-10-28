# Workflow Integration Notes

## Current Workflow Compatibility

The refactored action is **100% backward compatible** with the existing workflow in `main.yml`. No changes are required for the action to work.

## Current Workflow Structure

Your workflow in `.github/workflows/main.yml` currently has:
- 6 build stages (build-1 through build-6)
- Each stage checks if previous stage finished
- Stages 2-6 resume from artifact if needed

This structure works perfectly with the refactored action!

## Optional: Future Workflow Enhancements

### 1. Multi-Platform Support (Future)

When macOS and Windows builders are implemented, you could create a matrix workflow:

```yaml
strategy:
  matrix:
    platform: [linux, macos, windows]
    arch: [x64, arm64]
    exclude:
      # Example: if you don't want certain combinations
      - platform: windows
        arch: arm64

jobs:
  build-1:
    runs-on: ${{ matrix.platform == 'linux' && 'ubuntu-latest' || matrix.platform == 'macos' && 'macos-latest' || 'windows-latest' }}
    steps:
      - uses: ./.github/actions/stage
        with:
          platform: ${{ matrix.platform }}
          arch: ${{ matrix.arch }}
          finished: false
          from_artifact: false
```

### 2. Conditional Platform-Specific Steps

You could add platform-specific cleanup or setup:

```yaml
- name: Cleanup Disk (Linux only)
  if: matrix.platform == 'linux'
  uses: ./.github/actions/cleanup-disk

- name: Install Xcode (macOS only)
  if: matrix.platform == 'macos'
  uses: maxim-lobanov/setup-xcode@v1
  with:
    xcode-version: latest-stable
```

### 3. Dynamic Stage Count

Instead of hardcoding 6 stages, you could make it configurable:

```yaml
# In your repository variables
BUILD_STAGES: 6

jobs:
  build:
    strategy:
      matrix:
        stage: [1, 2, 3, 4, 5, 6]
    # ... rest of config
```

### 4. Artifact-Based Continuation

Currently, your workflow uses a fixed number of stages. You could make it dynamic:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Run Build Stage
        id: build
        uses: ./.github/actions/stage
        with:
          finished: ${{ env.FINISHED }}
          from_artifact: ${{ env.FROM_ARTIFACT }}
      
      - name: Check if more stages needed
        id: check
        run: |
          if [ "${{ steps.build.outputs.finished }}" == "false" ]; then
            echo "need_more_stages=true" >> $GITHUB_OUTPUT
          fi
      
      - name: Trigger next stage
        if: steps.check.outputs.need_more_stages == 'true'
        uses: benc-uk/workflow-dispatch@v1
        with:
          workflow: main.yml
          inputs: '{"from_artifact": "true"}'
```

## Recommended: No Changes Yet

For now, keep your existing workflow as-is. It works perfectly with the refactored action. Consider the enhancements above only when:

1. You implement macOS/Windows support
2. You want to support multiple architectures in parallel
3. You find the need for dynamic stage counts

## Testing the Refactored Action

To test the refactored action:

1. **Push to a test branch**:
   ```bash
   git checkout -b test-refactored-action
   git add .github/actions/stage/
   git commit -m "Refactor: Modular architecture for build action"
   git push origin test-refactored-action
   ```

2. **Update workflow to use test branch** (temporarily):
   ```yaml
   - name: Run Stage
     uses: ./.github/actions/stage@test-refactored-action
   ```

3. **Or, test on main** (since it's backward compatible):
   - Just push to main
   - The action interface hasn't changed
   - Existing workflows will use the new code automatically

4. **Monitor the logs** for:
   - Same log structure (with module prefixes now)
   - No errors from the new code
   - Checkpoint artifacts created successfully
   - Final artifact uploaded successfully

## Debugging Tips

If you encounter issues:

1. **Check log prefixes**:
   - `[Main]`: Main orchestration
   - `[Build]`: Build operations
   - `[Tar]`: Archive creation
   - `[Volume Script]`: Volume processing

2. **Compare with backup**:
   - Old code in `index.js.backup`
   - Check for behavioral differences

3. **Verify paths**:
   - Action now uses `src/main.js` as entry point
   - Ensure npm install ran in `.github/actions/stage`

4. **Enable debug logging**:
   ```yaml
   env:
     ACTIONS_STEP_DEBUG: true
   ```

## Rollback Plan

If you need to rollback:

1. **Quick rollback** (revert action.yml):
   ```yaml
   runs:
     using: 'node20'
     main: 'index.js.backup'  # Point to backup
   ```

2. **Full rollback**:
   ```bash
   git revert <commit-hash>
   ```

3. **Restore old structure**:
   ```bash
   cd .github/actions/stage
   rm -rf src/
   mv index.js.backup index.js
   git checkout action.yml package.json
   ```

## Success Metrics

After deployment, verify:

- ✅ Build completes in same time as before
- ✅ Artifacts have same size
- ✅ Checkpoints work correctly
- ✅ Resume from checkpoint works
- ✅ Final artifact uploads successfully
- ✅ No new errors in logs

## Support

For issues or questions about the refactored action:

1. Check `README.md` for usage
2. Check `ARCHITECTURE.md` for internals
3. Check `CHANGELOG.md` for what changed
4. Compare with `index.js.backup` if needed
5. Review log prefixes to identify component with issue

