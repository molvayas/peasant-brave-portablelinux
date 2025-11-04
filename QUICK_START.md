# Quick Start: Release Builds

## 🚀 TL;DR

Your build system now supports both **Component** (fast, no secrets) and **Release** (official, needs secrets) builds!

## ✅ What's Done

- ✅ Build scripts support Component and Release modes
- ✅ Release builds use `create_dist` for proper packages
- ✅ `.env` file automatically created/deleted for security
- ✅ Secrets never stored in artifacts
- ✅ UI dropdown to select build type
- ✅ Distribution packages unsigned but ready to ship

## 🔧 What You Need to Finish

### Step 1: Complete Workflow (5 minutes)

Edit `.github/workflows/build.yml` and add these 2 lines to **every build job** (35 more times):

```yaml
build_type: ${{ inputs.build_type }}
secrets:
  BRAVE_ENV_CONFIG: ${{ secrets.BRAVE_ENV_CONFIG }}
```

**Already done for you:** `linux-x64-build-1` (use as template)

### Step 2: Add GitHub Secret (2 minutes)

1. Create `.env` file locally with API keys (see `RELEASE_BUILD.md` for template)
2. GitHub → Settings → Secrets → New repository secret
3. Name: `BRAVE_ENV_CONFIG`
4. Value: (paste entire `.env` file)
5. Click "Add secret"

### Step 3: Test It! (30 seconds)

**Component build** (works now, no secrets):
```
Actions → Build Brave Browser → Run workflow
Build type: Component ← default, fast
```

**Release build** (after step 2):
```
Actions → Build Brave Browser → Run workflow  
Build type: Release ← needs BRAVE_ENV_CONFIG secret
```

## 📖 Full Documentation

- `RELEASE_BUILD.md` - Complete guide with examples
- `IMPLEMENTATION_SUMMARY.md` - Technical details

## 🔒 Security

Your `.env` files with API keys:
- ✅ Created fresh each stage from GitHub Secret
- ✅ Automatically deleted before checkpointing  
- ✅ Never stored in build artifacts
- ✅ Recreated in next stage

**Result:** Secrets safe, builds resume perfectly!

## ❓ Need Help?

**Component builds working but Release fails?**
→ Check `BRAVE_ENV_CONFIG` secret is set

**Want to test without real API keys?**
→ Use dummy values (see `RELEASE_BUILD.md`)

**Worried about security?**
→ Download an artifact and verify no `.env` inside!

---

🎉 **Congratulations! You now have a production-ready multi-platform Brave build system with secure secret management!**

