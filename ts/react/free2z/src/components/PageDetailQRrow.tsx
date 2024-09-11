import { Button, ButtonBase, Grid, Typography } from "@mui/material"
import React, { Fragment, ReactElement, useEffect, useState } from "react"
import QRAddress from "./QRAddress"

interface PageDetailQRRowProps {
    addr: string
    prompt?: string
    helpText?: string
    end?: ReactElement
}

export default function PageDetail(props: PageDetailQRRowProps) {
    return (
        <Fragment>
            <Grid item xs={4.5} md={4} lg={3}>
                <QRAddress addr={props.addr} size={84} prompt={props.prompt} />
            </Grid>
            <Grid item xs={6} md={5} lg={4}>
                {props.end}
                <Typography
                    // variant="caption"
                    textAlign="left"
                    // align="justify"
                >
                    {props.helpText}
                </Typography>
            </Grid>
        </Fragment>
    )
}
