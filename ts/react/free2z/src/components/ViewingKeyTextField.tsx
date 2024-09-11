import React from "react"

import { Link, TextField } from "@mui/material"
import { VKProps } from "./VKButton"

export const vkregex = /^zxviews[a-z0-9]{278}$/g

export interface VKTFProps {
    vk: string,
    setVK: (vk: string) => void,
    autoFocus: boolean,
    handleClose: () => void,
}

export default function ViewingKeyTextField(props: VKTFProps) {

    return (

        <TextField
            id="viewing-key"
            label="Viewing Key"
            type="text"
            autoFocus={props.autoFocus}
            margin="normal"
            helperText={
                <Link
                    href="https://electriccoin.co/blog/explaining-viewing-keys/"
                    target="_blank"
                >
                    "/^zxviews[a-z0-9]{278}$/"
                </Link>
            }
            // margin="dense"
            // color={page.title ? "primary" : "error"}
            color="primary"
            error={!!props.vk && !props.vk.match(vkregex)}
            fullWidth
            variant="standard"
            placeholder="Viewing Key"
            value={props.vk}
            onKeyDown={(v: any) => {
                if (v.keyCode === 13) {
                    // handleSave()
                    props.handleClose()
                }
            }}
            onChange={(v) => {
                props.setVK(v.target.value)
            }}
            required={false}

        />
    )
}

