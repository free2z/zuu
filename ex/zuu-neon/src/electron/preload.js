
const lib = require("../../index.node");
// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.

window.addEventListener("DOMContentLoaded", () => {
    const replaceText = (selector, text) => {
        const element = document.getElementById(selector);
        if (element) element.innerText = text;
    };
    // interesting it logs in the browser but I can't get a reference
    // to it like this ... we probably want to keep the lib on the backend
    // anyways and have the UI only reference indexeddb as much as possible
    console.log(lib)
    // window.blaze = lib

    for (const dependency of ["chrome", "node", "electron"]) {
        replaceText(`${dependency}-version`, process.versions[dependency]);
    }
    //   const numberOfCPUs = lib.get();
    //   const numberOfCPUsElement = document.getElementById("number-of-cpus");
    //   numberOfCPUsElement.innerText = numberOfCPUs;
});