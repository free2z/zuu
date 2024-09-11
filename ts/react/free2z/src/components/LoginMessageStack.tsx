import { LoginTwoTone } from "@mui/icons-material"
import { Stack, Typography, Tooltip, IconButton } from "@mui/material"
import { useLocation } from "react-router-dom"
import { useGlobalState } from "../state/global"
import { useTransitionNavigate } from "../hooks/useTransitionNavigate"

type MessageProps = {
    message: string
    noShow?: boolean
}

export default function LoginMessageStack(props: MessageProps) {
    const [loginModal, setLoginModal] = useGlobalState("loginModal")

    return (
        <Stack
            direction="row"
            alignItems="center"
            justifyContent="center"
        >
            {!props.noShow &&
                <Typography>{props.message}</Typography>
            }
            <Tooltip title={props.message}>
                <IconButton
                    onClick={() => {
                        setLoginModal(true)
                    }}
                >
                    <LoginTwoTone
                        fontSize="large"
                    />
                </IconButton>
            </Tooltip>
        </Stack>
    )
}