import { Agriculture } from "@mui/icons-material";
import React from "react";
import { Creator } from "../Begin";
import { MenuItemWithIcon } from "./AvatarMenu";
import TuzisDialog from "./TuzisDialog";


export default function TuzisMenuItem(props: Creator) {
    const [open, setOpen] = React.useState(false)
    const handleClickOpen = () => {
        setOpen(true)
    }
    if (!props.username) {
        return null
    }

    return (
        <>
            <TuzisDialog open={open} setOpen={setOpen} {...props} />
            <MenuItemWithIcon
                onClick={handleClickOpen}
                icon={
                    <Agriculture
                        color="secondary"
                    />
                }
                label="Buy 2Zs"
                tip={`You have ${Number(props.tuzis).toFixed(0)}`}
            />
        </>
    );
};
