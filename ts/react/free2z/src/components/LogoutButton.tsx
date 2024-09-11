import LogoutIcon from "@mui/icons-material/Logout"

import axios from "axios"
import { defaultCreator, useGlobalState } from "../state/global"
import { MenuItemWithIcon } from "./AvatarMenu"
import { useQueryClient } from "react-query"

type Props = {
    onClick?: () => void
}

export default function LogoutButton(props: Props) {
    const [creator, setCreator] = useGlobalState("creator")
    const [redirect, setRedirect] = useGlobalState("redirect")
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")
    const queryClient = useQueryClient()

    return (
        <MenuItemWithIcon
            onClick={() => {
                axios.post("/api/auth/logout/", {}).then(() => {
                    setRedirect("")
                    queryClient.clear()
                    setAuthStatus(false)
                    setCreator(defaultCreator)
                    queryClient.invalidateQueries('creatorData')
                    setAuthStatus(false)
                    setCreator(defaultCreator)
                }).catch((err) => {
                    console.log(err)
                })
                props.onClick && props.onClick()
            }}
            icon={
                <LogoutIcon
                    style={{
                        marginLeft: "2px"
                    }}
                />
            }
            label="Logout"
            tip="End Session"
        />
    )
}
