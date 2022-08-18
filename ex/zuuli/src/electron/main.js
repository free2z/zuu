// Module to control the application lifecycle and the native browser window.
const { app, BrowserWindow, protocol, shell } = require("electron");
const path = require("path");
const url = require("url");

const { ipcMain } = require('electron');
const { forkWarp } = require("./fork");

forkWarp()

//  // Event handler for synchronous incoming messages
//  ipcMain.on('synchronous-message', (event, arg) => {
//     console.log(arg)

//     // Synchronous event emmision
//     event.returnValue = 'sync pong'
//  })



// Create the native browser window.
function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 700,
        height: 800,
        // Set the path of an additional "preload" script that can be used to
        // communicate between the node-land and the browser-land.
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegrationInWorker: true,
        },
    });

    // In production, set the initial browser path to the local bundle generated
    // by the Create React App build process.
    // In development, set it to localhost to allow live/hot-reloading.
    const appURL = app.isPackaged
        ? url.format({
            pathname: path.join(__dirname, "index.html"),
            protocol: "file:",
            slashes: true,
        })
        : "http://localhost:3000";
    mainWindow.loadURL(appURL);

    // Automatically open Chrome's DevTools in development mode.
    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools();
    }

    // IPC -------------------------------------------
    // Event handler for asynchronous incoming messages
    ipcMain.on('open', (event, arg) => {
        console.log("OPEN", event, arg)
        shell.openExternal(arg)
    })
    ipcMain.on('rewind', (event, arg) => {
        // TODO: shouldn't really rewind except to birthday
        // or up to 100 blocks for reorg.
        // BUT rescan between TX and witnesses can result in lost witnesses
        // so, really, we should have an "earliest height" for all accounts
        // and then just rescan from there instead of letting the user
        // guess/choose
        // return
        console.log("REWIND", event, arg)
        // console.log(arg)
        // console.log("KILLING", p.kill)
        // p.kill()
        // console.log("Killed", p.killed)
        // let's see about this arg ...
        // TODO: should rewind to birthday
        // warp.rewindToHeight(arg)

        // Just a fake to work on the snackbar/IPC for now ...
        // Event emitter for sending asynchronous messages
        event.sender.send('ipcsnackbar', {
            message: "kilt",
            severity: "success",
        })
    })
}

// Setup a local proxy to adjust the paths of requested files when loading
// them from the local production bundle (e.g.: local fonts, etc...).
function setupLocalFilesNormalizerProxy() {
    protocol.registerHttpProtocol(
        "file",
        (request, callback) => {
            const url = request.url.substr(8);
            callback({ path: path.normalize(`${__dirname}/${url}`) });
        },
        (error) => {
            if (error) console.error("Failed to register protocol");
        }
    );
}

// This method will be called when Electron has finished its initialization and
// is ready to create the browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
    createWindow();
    setupLocalFilesNormalizerProxy();

    app.on("activate", function () {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Quit when all windows are closed, except on macOS.
// There, it's common for applications and their menu bar to stay active until
// the user quits  explicitly with Cmd + Q.
app.on("window-all-closed", function () {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

// If your app has no need to navigate or only needs to navigate to known pages,
// it is a good idea to limit navigation outright to that known scope,
// disallowing any other kinds of navigation.
const allowedNavigationDestinations = "https://free2z.cash";
app.on("web-contents-created", (event, contents) => {
    contents.on("will-navigate", (event, navigationURL) => {
        const parsedURL = new URL(navigationURL);
        if (!allowedNavigationDestinations.includes(parsedURL.origin)) {
            event.preventDefault();
        }
    });
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

//
