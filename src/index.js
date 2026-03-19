// Handle Squirrel events manually to prevent desktop shortcuts
if (require('electron').app) {
    const squirrelCommand = process.argv[1];
    if (handleSquirrelEvent(squirrelCommand)) {
        return;
    }
}

function handleSquirrelEvent(squirrelCommand) {
    const app = require('electron').app;

    if (process.platform !== 'win32') {
        return false;
    }

    const path = require('path');
    const childProcess = require('child_process');
    const appFolder = path.resolve(process.execPath, '..');
    const rootAtomFolder = path.resolve(appFolder, '..');
    const updateDotExe = path.resolve(path.join(rootAtomFolder, 'Update.exe'));
    const exeName = path.basename(process.execPath);

    const spawn = function(command, args) {
        let spawnedProcess;
        try {
            spawnedProcess = childProcess.spawn(command, args, { detached: true });
        } catch (error) {
            console.error('Spawn error:', error);
        }
        return spawnedProcess;
    };

    const spawnUpdate = function(args) {
        return spawn(updateDotExe, args);
    };

    switch (squirrelCommand) {
        case '--squirrel-install':
        case '--squirrel-updated':
            // Create Start Menu shortcut only (no desktop shortcut)
            spawnUpdate(['--createShortcut', exeName, '-l', 'StartMenu']);
            setTimeout(app.quit, 1000);
            return true;

        case '--squirrel-uninstall':
            // Remove shortcuts
            spawnUpdate(['--removeShortcut', exeName]);
            setTimeout(app.quit, 1000);
            return true;

        case '--squirrel-obsolete':
            app.quit();
            return true;
    }

    return false;
}

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { createWindow, updateGlobalShortcuts } = require('./utils/window');
const { setupGeminiIpcHandlers, stopMacOSAudioCapture, sendToRenderer } = require('./utils/gemini');
const { setupGroqIpcHandlers } = require('./utils/groq');
const { initializeRandomProcessNames } = require('./utils/processRandomizer');
const { applyAntiAnalysisMeasures } = require('./utils/stealthFeatures');
const { getLocalConfig, writeConfig } = require('./config');
const path = require('path');
const os = require('os');

// Fix userData directory to consistent location across dev/prod
// This ensures settings persist when running npm start on macOS
if (process.platform === 'darwin') {
    const userDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'cheating-daddy');
    app.setPath('userData', userDataPath);
}

const geminiSessionRef = { current: null };
let mainWindow = null;

// Initialize random process names for stealth
const randomNames = initializeRandomProcessNames();

function createMainWindow() {
    mainWindow = createWindow(sendToRenderer, geminiSessionRef, randomNames);
    return mainWindow;
}

// Single instance lock - prevent multiple instances of the app
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // Another instance is already running, quit this one
    app.quit();
} else {
    // Someone tried to run a second instance, focus our window instead
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
            mainWindow.show();
        }
    });

    app.whenReady().then(async () => {
        try {
            // Apply anti-analysis measures with random delay
            await applyAntiAnalysisMeasures();

            // Log user data directory for debugging persistence issues
            console.log('Electron user data directory:', app.getPath('userData'));
            console.log('Platform:', process.platform);
            console.log('Electron version:', process.versions.electron);
            console.log('Node version:', process.versions.node);

            // Hide dock icon on macOS for stealth (similar to InterviewCoder)
            if (process.platform === 'darwin') {
                app.dock.hide();
                console.log('Dock icon hidden on macOS');
            }

            // Windows-specific: Ensure proper IPC initialization
            if (process.platform === 'win32') {
                console.log('Initializing on Windows - setting up IPC handlers...');
                
                // Add small delay on Windows to ensure pipe is ready
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            createMainWindow();
            
            console.log('Setting up IPC handlers...');
            setupGeminiIpcHandlers(geminiSessionRef);
            setupGroqIpcHandlers();
            setupGeneralIpcHandlers();
            
            console.log('✅ All IPC handlers registered successfully');
            console.log('App ready - windows open:', BrowserWindow.getAllWindows().length);
        } catch (error) {
            console.error('❌ CRITICAL ERROR during app initialization:', error);
            console.error('Stack trace:', error.stack);
            
            // Show error dialog to user
            const { dialog } = require('electron');
            dialog.showErrorBox(
                'Startup Error',
                'Failed to initialize the application.\n\n' +
                'Error: ' + error.message + '\n\n' +
                'Please restart the app or check the console for details.'
            );
            
            // Attempt recovery
            setTimeout(() => {
                console.log('Attempting recovery...');
                try {
                    createMainWindow();
                    setupGeminiIpcHandlers(geminiSessionRef);
                    setupGroqIpcHandlers();
                    setupGeneralIpcHandlers();
                    console.log('✅ Recovery successful');
                } catch (recoveryError) {
                    console.error('❌ Recovery failed:', recoveryError);
                }
            }, 2000);
        }
    });
}

app.on('window-all-closed', () => {
    stopMacOSAudioCapture();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async (event) => {
    stopMacOSAudioCapture();

    // Flush localStorage and other storage to disk before quitting
    // This is CRITICAL for macOS to persist localStorage between restarts
    event.preventDefault();
    try {
        const { session } = require('electron');
        console.log('Flushing storage data to disk...');
        await session.defaultSession.flushStorageData();
        console.log('Storage data flushed successfully');
    } catch (error) {
        console.error('Error flushing storage data:', error);
    }

    // Now actually quit
    app.exit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
    }
});

// Windows-specific error handling for named pipe issues
if (process.platform === 'win32') {
    // Catch unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled Rejection on Windows:', reason);
        console.error('Stack:', reason?.stack || 'No stack');
        
        // Don't crash - log and continue
        // This prevents the "no process at other end of pipe" error from crashing
    });

    // Catch uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('❌ Uncaught Exception on Windows:', error);
        console.error('Stack:', error.stack);
        
        // Show user-friendly error
        try {
            const { dialog } = require('electron');
            if (dialog && mainWindow) {
                dialog.showErrorBox(
                    'Application Error',
                    'An unexpected error occurred.\n\n' +
                    error.message + '\n\n' +
                    'The app will try to continue.'
                );
            }
        } catch (e) {
            // Ignore dialog errors
        }
        
        // Don't exit - keep app running
        // process.exit(1); // Commented out to prevent crashes
    });
}

// Global error handler for IPC communication errors
process.on('warning', (warning) => {
    if (warning.message && warning.message.includes('pipe')) {
        console.warn('⚠️ IPC Pipe warning (Windows):', warning.message);
        // This is often temporary on Windows - don't crash
    } else {
        console.warn('Process warning:', warning);
    }
});

function setupGeneralIpcHandlers() {
    // Config-related IPC handlers
    ipcMain.handle('set-onboarded', async (event) => {
        try {
            const config = getLocalConfig();
            config.onboarded = true;
            writeConfig(config);
            return { success: true, config };
        } catch (error) {
            console.error('Error setting onboarded:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('set-stealth-level', async (event, stealthLevel) => {
        try {
            const validLevels = ['visible', 'balanced', 'ultra'];
            if (!validLevels.includes(stealthLevel)) {
                throw new Error(`Invalid stealth level: ${stealthLevel}. Must be one of: ${validLevels.join(', ')}`);
            }
            
            const config = getLocalConfig();
            config.stealthLevel = stealthLevel;
            writeConfig(config);
            return { success: true, config };
        } catch (error) {
            console.error('Error setting stealth level:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('set-layout', async (event, layout) => {
        try {
            const validLayouts = ['compact'];
            if (!validLayouts.includes(layout)) {
                throw new Error(`Invalid layout: ${layout}. Must be one of: ${validLayouts.join(', ')}`);
            }

            const config = getLocalConfig();
            config.layout = layout;
            writeConfig(config);
            return { success: true, config };
        } catch (error) {
            console.error('Error setting layout:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-config', async (event) => {
        try {
            const config = getLocalConfig();
            return { success: true, config };
        } catch (error) {
            console.error('Error getting config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('quit-application', async event => {
        try {
            stopMacOSAudioCapture();
            app.quit();
            return { success: true };
        } catch (error) {
            console.error('Error quitting application:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('open-external', async (event, url) => {
        try {
            await shell.openExternal(url);
            return { success: true };
        } catch (error) {
            console.error('Error opening external URL:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('update-keybinds', (event, newKeybinds) => {
        if (mainWindow) {
            updateGlobalShortcuts(newKeybinds, mainWindow, sendToRenderer, geminiSessionRef);
        }
    });

    ipcMain.handle('update-content-protection', async (event, contentProtection) => {
        try {
            if (mainWindow) {

                // Get content protection setting from localStorage via cheddar
                const contentProtection = await mainWindow.webContents.executeJavaScript('cheddar.getContentProtection()');
                mainWindow.setContentProtection(contentProtection);
                console.log('Content protection updated:', contentProtection);
            }
            return { success: true };
        } catch (error) {
            console.error('Error updating content protection:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-random-display-name', async event => {
        try {
            return randomNames ? randomNames.displayName : 'System Monitor';
        } catch (error) {
            console.error('Error getting random display name:', error);
            return 'System Monitor';
        }
    });

    // VAD (Voice Activity Detection) handler
    ipcMain.handle('send-vad-audio-segment', async (event, audioSegment) => {
        try {
            // Forward VAD-processed audio segment to Gemini or audio processing
            // This handler bridges VAD output to existing audio processing pipeline
            console.log('Received VAD audio segment:', audioSegment ? 'Valid segment' : 'Invalid segment');
            
            // You can add additional processing here if needed
            // For now, this just acknowledges receipt of the VAD segment
            return { success: true };
        } catch (error) {
            console.error('Error processing VAD audio segment:', error);
            return { success: false, error: error.message };
        }
    });

    // VAD settings update handler
    ipcMain.handle('update-vad-setting', async (event, vadEnabled) => {
        try {
            console.log('VAD setting updated:', vadEnabled ? 'enabled' : 'disabled');
            // Store VAD setting if needed for main process
            return { success: true };
        } catch (error) {
            console.error('Error updating VAD setting:', error);
            return { success: false, error: error.message };
        }
    });
}
