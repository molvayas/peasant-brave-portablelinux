# Bug Fix: Timeout Calculation

## Issue

The initial refactoring had a bug in timeout calculation. The `jobStartTime` was being set in the builder constructor, which would be **after** the orchestrator had already done some work (like restoring from artifacts).

## Original Implementation ✅

```javascript
// At the very top of the action
const JOB_START_TIME = Date.now();

// Later, during build:
const elapsedTime = Date.now() - JOB_START_TIME;
let remainingTime = MAX_BUILD_TIME - elapsedTime;
```

**Timeout calculation**: `MAX_BUILD_TIME (300 min) - elapsed time since job start`

This means:
- Job starts at T=0
- Spends 20 minutes on init, downloads, etc.
- Build gets: 300 - 20 = **280 minutes timeout**

## Buggy Refactored Version ❌

```javascript
class LinuxBuilder {
    constructor(braveVersion, arch) {
        // ...
        this.jobStartTime = Date.now();  // ❌ Set in constructor
    }
}

// In orchestrator:
this.builder = createBuilder(...);  // Builder created here
await this.builder.initialize();     // Takes 20 minutes
await this.builder.runBuild();       // Uses jobStartTime from constructor
```

**Problem**: `jobStartTime` is set when builder is created, not when the job/action starts. But if there's work before the builder is created, or between creation and `runBuild()`, the timeout calculation would be wrong.

## Fixed Version ✅

```javascript
class BuildOrchestrator {
    constructor(options) {
        // Track job start time at orchestrator creation (top of action)
        this.jobStartTime = Date.now();  // ✅ Set at very top
        
        this.builder = createBuilder(...);
        
        // Pass job start time to builder
        this.builder.jobStartTime = this.jobStartTime;  // ✅ Explicitly set
    }
}

class LinuxBuilder {
    constructor(braveVersion, arch) {
        // ...
        // jobStartTime will be set by orchestrator
        this.jobStartTime = null;  // ✅ Will be set externally
    }
    
    async runBuild() {
        // Validate that jobStartTime was set
        if (!this.jobStartTime) {
            throw new Error('jobStartTime not set!');
        }
        
        const timing = calculateBuildTimeout(this.jobStartTime, ...);
    }
}
```

## How It Works Now

```
T=0: GitHub Actions job starts
T=0: Action runs, orchestrator created
     → this.jobStartTime = Date.now()  ← Captured here!
     
T=0: Builder created
     → builder.jobStartTime = null
     
T=0: Orchestrator sets builder.jobStartTime
     → builder.jobStartTime = orchestrator.jobStartTime
     
T=20min: Various setup completes (restore artifacts, install deps, etc.)

T=20min: runBuild() is called
         → calculates: 300min - (now - jobStartTime)
         → = 300min - 20min
         → = 280 minute timeout  ✅ Correct!
```

## Timeline Example

```
00:00 - Job starts, orchestrator created (jobStartTime = T0)
00:05 - Restore from artifact (5 min)
00:10 - Install dependencies (5 min)
00:15 - Run npm init (5 min)
00:20 - Cleanup source tree (5 min)
----- Total elapsed: 20 minutes -----
00:20 - runBuild() called
        Timeout = 300 - 20 = 280 minutes ✅
```

## Why This Matters

If you don't account for time spent before the build:
- **Bad**: Build gets full 300 min, but job has been running for 20 min
  - Result: Job times out before build timeout
  - Build killed unexpectedly
  
- **Good**: Build gets 280 min (accounting for 20 min already spent)
  - Result: Build times out gracefully with checkpoint
  - Resumable in next stage

## Verification

The timeout calculation logs this info:
```
Time elapsed in job: 0.33 hours (20 minutes)
Remaining time calculated: 4.67 hours (280 minutes)
Final timeout: 280 minutes (4.67 hours)
```

Watch for these logs to verify it's working correctly!

## Related Code

- **Set**: `src/orchestrator.js` line 33
- **Passed**: `src/orchestrator.js` line 39
- **Validated**: `src/build/linux.js` line 80-82
- **Used**: `src/utils/exec.js` `calculateBuildTimeout()` function

## Testing

To verify this works:
1. Check logs show "Time elapsed in job" > 0
2. Verify "Remaining time" = MAX_TIME - elapsed
3. Confirm build actually uses the calculated timeout
4. Test checkpoint creation when timeout occurs

## Status

✅ **Fixed** - Timeout now correctly accounts for all time spent in the job before build starts.

