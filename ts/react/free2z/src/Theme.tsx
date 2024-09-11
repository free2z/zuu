// Importing specific weights and styles
import "@fontsource/roboto/400.css"; // Weight 400.
import "@fontsource/roboto/500.css"; // Weight 500.
import "@fontsource/roboto/700.css"; // Weight 700.

import { createTheme } from "@mui/material";

// const lightPrimary = {
//     500: "#6977e0",
// }
// const lightSecondary = {
//     A400: "#9300c4",
// }
// const lightInfo = {
//     500: "#7fa3f7",
// }
// const lightWarn = {
//     500: "#fc6852",
// }
// const lightError = {
//     500: "#800020",
// }
// const lightSuccess = {
//     500: "#39a35b",
// }
const lightPrimary = {
    500: "#6977e0", // Retained: A vibrant, medium blue that’s bright and engaging.
    700: "#4e5bb8", // Darker shade for depth.
}

const lightSecondary = {
    A400: "#9300c4", // Retained: A deep purple that complements the primary blue.
    A200: "#b832e8", // A lighter, more psychedelic purple.
}

const lightInfo = {
    500: "#7fa3f7", // A light, calming blue that provides a sense of trust.
    300: "#bdc9f9", // Even lighter for less critical informational cues.
}

const lightWarn = {
    500: "#fc6852", // A striking coral that stands out without clashing.
    700: "#e65030", // A darker, more subdued tone for serious warnings.
}

const lightError = {
    500: "#e63950", // A rich, deep pink with a hint of purple for a modern take on 'error'.
    700: "#b2273c", // Darker and more reserved, suitable for darker themes or serious errors.
}

const lightSuccess = {
    // 500: "#39a35b", // A fresh, vibrant green that suggests growth and success.
    500: "#2c7a45", // A darker green that could be used for more subdued success messages.
}

const lightAccent = {
    500: "#f0a", // A bright and funky fuchsia for an accent color, which is very psychedelic.
    700: "#c05", // A richer shade of fuchsia for varied use in the palette.
}



const darkPrimary = {
    // 500: "#c8c9f4",
    // 500: "#a3a7ec",
    // 500: "#7d84e5",
    // 500: "#7297f6",
    // 500: "#82aaf9",
    // 500: "#c4d9fe",
    500: "#a1c2fc",
}

const darkSecondary = {
    A400: "#e884f4",
}
const darkSuccess = {
    // 500: "#6af8f0",
    500: "#7cca93",
}

const darkInfo = {
    // 500: "#b6c7fa",
    500: "#cdaefb",
}

const darkWarn = {
    500: "#ff7a6b",
}

const darkError = {
    500: "#f760ac",
}


const darkPalette = {
    primary: darkPrimary,
    secondary: darkSecondary,
    success: darkSuccess,
    info: darkInfo,
    warning: darkWarn,
    error: darkError,
}

const lightPalette = {
    primary: lightPrimary,
    secondary: lightSecondary,
    success: lightSuccess,
    info: lightInfo,
    warning: lightWarn,
    error: lightError,
}


export default function getTheme(darkMode: Boolean) {
    // console.log("DARKMODE")
    const mode = darkMode ? "dark" : "light"
    const pallet = darkMode ? darkPalette : lightPalette

    return createTheme({
        palette: {
            mode: mode,
            ...pallet,
        },
        typography: {
            fontFamily: "Roboto, sans-serif",
            fontSize: 16,
            // fontWeightBold: 900,
            // fontWeightMedium: 800,
            // fontWeightLight: 700,
            // fontWeight: "120%",
        },
    });
}
