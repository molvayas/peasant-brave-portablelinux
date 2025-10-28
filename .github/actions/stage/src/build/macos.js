/**
 * macOS-specific build implementation for Brave Browser
 * 
 * TODO: Implement macOS build logic
 * This is a placeholder for future macOS support
 */

const {getPlatformConfig, getBuildPaths, STAGES} = require('../config/constants');

class MacOSBuilder {
    constructor(braveVersion, arch = 'x64') {
        this.braveVersion = braveVersion;
        this.arch = arch;
        this.platform = 'macos';
        this.config = getPlatformConfig(this.platform);
        this.paths = getBuildPaths(this.platform);
        // jobStartTime will be set by orchestrator after construction
        this.jobStartTime = null;
    }

    async initialize() {
        throw new Error('macOS builder not yet implemented');
    }

    async runInit() {
        throw new Error('macOS builder not yet implemented');
    }

    async runBuild() {
        throw new Error('macOS builder not yet implemented');
    }

    async package() {
        throw new Error('macOS builder not yet implemented');
    }

    async getCurrentStage() {
        throw new Error('macOS builder not yet implemented');
    }

    async setStage(stage) {
        throw new Error('macOS builder not yet implemented');
    }
}

module.exports = MacOSBuilder;

