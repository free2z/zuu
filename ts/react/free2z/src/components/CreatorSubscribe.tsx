import { useState } from "react";
import {
    Tooltip, IconButton, Button, useTheme,
} from "@mui/material"
import { GroupAddOutlined } from "@mui/icons-material";
import SubscribeToCreator from "./SubscribeToCreator";
import { PublicCreatorPlaced } from "./YouAreSubscribed";


export default function CreatorSubscribe(props: PublicCreatorPlaced & { isButton?: boolean, setShowPay?: () => void }) {
    const [open, setOpen] = useState(false)
    const theme = useTheme()
    const isDarkMode = theme.palette.mode === "dark"
    const { isButton } = props

    return (
        <>
            <SubscribeToCreator
                showPay={open}
                setShowPay={props.setShowPay || setOpen}
                star={props}
            />
            {isButton ? (
                <Button
                    color="secondary"
                    size="small"
                    variant="contained"
                    onClick={() => {
                        setOpen(true);
                    }}
                    sx={{ color: isDarkMode ? "#121212" : "white" }}
                >
                    SUBSCRIBE
                </Button>
            ) : (
                <Tooltip title="Subscribe to Creator" placement={props.placement}>
                    <IconButton
                        size="large"
                        onClick={() => {
                            // console.log("OPEN")
                            setOpen(true)
                        }}
                    >
                        <GroupAddOutlined
                            // variant="outlined"
                            color="secondary"
                        />
                    </IconButton>
                </Tooltip>
            )}
        </>
    )
}
