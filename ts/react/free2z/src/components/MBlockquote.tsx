import { Paper } from "@mui/material"

export default function MBlockquote(props: any) {
    const { children } = props
    return (
        <Paper
            sx={{
                padding: "0.42em 1em 0.3em 1em",
                margin: "0.42em 0",
                // backgroundColor,
                // border
                // borderBlockStartColor: "primary",
                // TODO: hrm ...
                borderLeft: `3px solid #42a5f5`,
            }}
        >
            {children}
        </Paper>
    )
}
