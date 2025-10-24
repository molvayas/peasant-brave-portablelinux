# Timeout Handling in Multi-Stage Workflow (Linux)

## The Critical Feature

**Timeout handling is THE most important feature** that makes multi-stage builds work. Without it, builds would run until GitHub Actions kills the job at 6 hours, wasting time and not creating checkpoints.

## Implementation: Linux Native `timeout` Command

Unlike Windows which requires complex child process management, **Linux has a built-in `timeout` command** (inspired by ungoogled-chromium-portablelinux).

### execWithTimeout Function (Lines 16-44)

```javascript
async function execWithTimeout(command, args, options = {}) {
    const {cwd, timeoutSeconds} = options;
    
    // Use Linux native timeout command
    const timeoutArgs = [
        '-k', '5m',              // Kill after 5 min if not responding
        '-s', 'INT',             // Send SIGINT first (graceful)
        `${timeoutSeconds}s`,    // Timeout in seconds
        command,
        ...args
    ];
    
    const exitCode = await exec.exec('timeout', timeoutArgs, {
        cwd: cwd,
        ignoreReturnCode: true
    });
    
    return exitCode;  // Returns 124 if timeout occurred
}
```

**That's it!** ~30 lines vs ~80 lines of complex Windows code.

### How Linux `timeout` Works

```bash
timeout -k 5m -s INT 16200s npm run build
```

| Flag | Meaning |
|------|---------|
| `-k 5m` | If process doesn't die after SIGINT, send SIGKILL after 5 minutes |
| `-s INT` | Send SIGINT (interrupt, like Ctrl+C) as initial signal |
| `16200s` | Timeout duration (4.5 hours = 16200 seconds) |
| Exit code 124 | Timeout occurred |
| Exit code 0 | Success |
| Exit code other | Command failed |

### Comparison: Windows vs Linux

| Aspect | Windows | Linux |
|--------|---------|-------|
| **Implementation** | Manual child_process.spawn + timers | Native `timeout` command |
| **Lines of code** | ~80 lines | ~30 lines |
| **Complexity** | High | Low |
| **Kill command** | `taskkill /T /F /PID` | Built into `timeout` |
| **Graceful attempts** | 3 manual attempts | Automatic (SIGINT → SIGKILL) |
| **Timeout code** | 999 (custom) | 124 (standard) |

## Usage in Build Stage

```javascript
// Stage 2: npm run build
const JOB_START_TIME = Date.now();
const MAX_JOB_TIME = 270 * 60 * 1000; // 4.5 hours in milliseconds

// Calculate remaining time
const elapsedTime = Date.now() - JOB_START_TIME;
let remainingTime = MAX_JOB_TIME - elapsedTime;

// Minimum 10 minutes
const MIN_TIMEOUT = 10 * 60 * 1000;
if (remainingTime < MIN_TIMEOUT) {
    remainingTime = MIN_TIMEOUT;
}

const timeoutSeconds = Math.floor(remainingTime / 1000);

const buildCode = await execWithTimeout('npm', ['run', 'build'], {
    cwd: braveDir,
    timeoutSeconds: timeoutSeconds  // ← CALCULATED, NOT FIXED
});

if (buildCode === 124) {
    // Timeout reached (exit code 124 = timeout per Linux convention)
    console.log('⏱️ Build timed out - will resume in next stage');
}
```

**Important:** Timeout is **calculated** based on time already spent in the job!

## Why 4.5 Hours Max?

GitHub Actions has a 6-hour limit. We use **4.5 hours** as the maximum because:

1. **Compression time**: tar+zstd takes 10-20 minutes
2. **Upload time**: 15-20GB artifact takes 10-15 minutes  
3. **Safety buffer**: 30 minutes for unexpected delays

**Total**: 4.5h max build + 0.5-1h cleanup = 5-5.5h < 6h limit

## Why Calculate Remaining Time?

**Scenario**: If `npm run init` + `install-build-deps.sh` takes 2 hours:
- ❌ **Fixed 4.5h timeout**: Total = 2h + 4.5h = 6.5h > **EXCEEDS 6h limit!**
- ✅ **Calculated timeout**: Remaining = 4.5h - 2h = 2.5h timeout → Total = 4.5h < 6h ✓

**The calculation ensures we never exceed the job limit.**

## Why 10 Minutes Minimum?

If we're near the end of a job (e.g., 4h 28min elapsed):
- Calculated remaining: 4.5h - 4h 28min = 2 minutes
- Too short for meaningful work
- Set to 10 minutes minimum to allow some progress

**Why seconds not milliseconds?**
- Linux `timeout` command expects seconds
- Convert: `Math.floor(remainingTime / 1000)`

## Timeout Flow

```
Job starts
    ↓
timeout -k 5m -s INT 16200s npm run build
    ↓
[Compiling... 4.5 hours pass]
    ↓
timeout command fires:
    ↓
1. Send SIGINT (graceful interrupt, like Ctrl+C)
   [npm/ninja catches SIGINT, starts cleanup]
   Wait up to 5 minutes
2. If still running: Send SIGKILL (force kill)
    ↓
npm exits with code 124 (timeout)
    ↓
Checkpoint created (build-stage.txt stays "build")
    ↓
Artifact uploaded
    ↓
Job ends
    ↓
Next stage:
    ↓
Download artifact
Extract
Read marker: "build"
Resume npm run build with new 4.5h timeout
```

## Why This Matters

### Without Timeout
```
Stage 1: npm run build
[6 hours pass]
GitHub Actions: "Time limit exceeded, killing job"
No checkpoint saved (killed mid-upload)
Next stage: Starts from beginning
Total time: INFINITE (never completes)
```

### With Timeout
```
Stage 1: timeout -k 5m -s INT 16200s npm run build
[4.5 hours pass]
timeout: Kills gracefully, exits 124
Checkpoint saved at current progress
Next stage: Resumes from checkpoint
Total time: 12-15 hours (completes!)
```

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Mark stage complete, continue to package |
| 124 | Timeout (standard Linux timeout exit code) | Save checkpoint, next stage resumes |
| Other | Error | Stay in same stage, retry next run |

## Timeout Calculation Algorithm

```javascript
// Track when job started
const JOB_START_TIME = Date.now();
const MAX_JOB_TIME = 270 * 60 * 1000; // 4.5 hours max

// When build stage runs:
const elapsedTime = Date.now() - JOB_START_TIME;
let remainingTime = MAX_JOB_TIME - elapsedTime;

// Apply minimum
const MIN_TIMEOUT = 10 * 60 * 1000; // 10 minutes
if (remainingTime < MIN_TIMEOUT) {
    remainingTime = MIN_TIMEOUT;
}

// Convert to seconds for Linux timeout command
const timeoutSeconds = Math.floor(remainingTime / 1000);
```

**Why calculate dynamically?**
- init stage can take 1-3 hours (unpredictable)
- install-build-deps.sh adds 5-15 minutes
- Must ensure: elapsed + build timeout ≤ 4.5h
- Prevents exceeding GitHub's 6h limit

**Example timeline:**
```
0:00 - Job starts
0:05 - npm install complete
2:30 - npm run init complete (took 2h 25m)
2:40 - install-build-deps.sh complete (took 10m)
      elapsed = 2h 40m = 160 min
      remaining = 270min - 160min = 110min
      timeout = 110 * 60 = 6600 seconds
2:40 - npm run build starts with 110min timeout
```

## Testing the Timeout

To test timeout handling:

```javascript
// In index.js, temporarily set:
const MAX_JOB_TIME = 5 * 60 * 1000;  // 5 minutes instead of 4.5 hours

// Run workflow - should timeout quickly and create checkpoint
// The build will get: remaining = 5min - init_time
```

Or test with a very short build timeout:
```javascript
const MIN_TIMEOUT = 1 * 60 * 1000;  // 1 minute instead of 10
```

## Comparison: ungoogled-chromium-portablelinux Approach

Their build script uses shell timeout:
```bash
timeout -k 5m -s INT "${_task_timeout}"s ninja -C out/Default chrome
```

**We use the EXACT SAME approach!**

```javascript
// Our implementation (JavaScript wrapper around same command)
const timeoutArgs = ['-k', '5m', '-s', 'INT', `${timeoutSeconds}s`, command, ...args];
await exec.exec('timeout', timeoutArgs, {cwd, ignoreReturnCode: true});
```

**Why this is perfect**:
- Native Linux tool (no installation needed)
- Standard exit code 124 for timeout
- Automatic graceful → force kill
- Simple and battle-tested
- Same approach used by ungoogled-chromium

## Why Graceful Shutdown Matters

Ninja (Chromium's build system) needs time to:
1. Finish current compilation unit
2. Write object files to disk
3. Update dependency cache
4. Clean up temp files

**Graceful SIGTERM**: Ninja catches signal and cleans up
**Force SIGKILL**: Ninja dies immediately, may corrupt files

That's why we do 3 SIGTERM attempts before SIGKILL.

## Monitoring Timeout Behavior

In GitHub Actions logs, look for:

```
Running: npm run build
Timeout: 270 minutes (4.50 hours)
[... compilation output ...]
⏱️ Timeout reached after 270 minutes
Attempting graceful shutdown...
Attempt 1/3: Sending SIGTERM to process tree (PID 12345)...
Attempt 2/3: Sending SIGTERM again...
Attempt 3/3: Sending SIGTERM final attempt...
Force killing remaining processes...
Process tree forcefully terminated
Build process stopped due to timeout
⏱️ npm run build timed out - will resume in next stage
```

## Critical Sections Protected by Timeout

| Section | Timeout | Why |
|---------|---------|-----|
| npm run init | None (exempt) | Must complete fully |
| install-build-deps.sh | None (exempt) | System packages, fast |
| **npm run build** | **4.5 hours** | **LONG compilation, needs timeout** |

## Future Improvements

1. **Dynamic timeout**: Calculate based on checkpoint progress
   ```javascript
   const filesCompiled = countObjectFiles();
   const estimatedRemaining = estimateTimeRemaining(filesCompiled);
   ```

2. **Progress reporting**: Show % complete before timeout
   ```javascript
   // Parse ninja output: [1234/40000] Compiling...
   ```

3. **Smart resumption**: Skip already-compiled files
   ```javascript
   // Ninja does this automatically via .ninja_deps
   ```

## The Bottom Line

**Without execWithTimeout**: Workflow doesn't work, wastes 6 hours per stage, never completes

**With execWithTimeout**: Workflow saves progress every 4.5 hours, completes in 12-15 hours total

This is **THE feature** that makes the entire multi-stage approach possible.

