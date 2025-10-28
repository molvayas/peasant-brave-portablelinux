/**
 * Windows-specific disk cleanup
 * 
 * TODO: Implement Windows cleanup logic
 * This is a placeholder for future Windows support
 */

class WindowsCleanup {
    constructor() {
        this.buildDirLocation = 'C:\\';
    }

    async showDiskSpace() {
        throw new Error('Windows cleanup not yet implemented');
    }

    async run() {
        throw new Error('Windows cleanup not yet implemented');
    }
}

module.exports = WindowsCleanup;

