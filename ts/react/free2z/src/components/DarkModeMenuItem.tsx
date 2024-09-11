import LogoutIcon from "@mui/icons-material/Logout"

import axios from "axios"
import { defaultCreator, useGlobalState } from "../state/global"
import { MenuItemWithIcon } from "./AvatarMenu"
import DarkMode from "./DarkMode"
import { Brightness3, Brightness7 } from "@mui/icons-material"
import { dispatch, useStoreState } from "../state/persist"


export default function DarkModeMenuButton() {
    const darkMode = useStoreState("darkmode")

    let Icon;
    if (!darkMode) {
        Icon = <Brightness3
            color="warning"
        />
    } else {
        Icon = <Brightness7
            color="warning"
        />
    }
    return (
        <MenuItemWithIcon
            onClick={() => {
                dispatch({
                    type: "setDarkmode",
                    darkmode: !darkMode,
                })
            }}
            icon={Icon}
            label={darkMode ? "Light" : "Dark"}
            tip="Toggle Dark Mode"
        />
    )
}
