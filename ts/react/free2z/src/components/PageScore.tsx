import React, { Fragment, useEffect, useState } from "react"
import { Badge, Grid, Tooltip } from "@mui/material"
import { PageInterface } from "./PageRenderer"
import { StyledBadge } from "./Find"

export interface PageScoreProps {
    page: PageInterface
}

export default function PageScore(props: PageScoreProps) {
    const { page } = props

    return (
        <Tooltip
            title="Calculated zPage Score"
            children={
                <Badge
                    max={99999}
                    badgeContent={
                        (page.f2z_score || "")
                            .toString()
                            .slice(0, 6)
                    }
                    color={parseInt(page.f2z_score) > 0.001 ? "primary" : "error"}
                    showZero={true}
                ></Badge>
            }
        />
    )
}
