
import {
    Divider,
    Grid,
    Paper,
    Typography,
} from "@mui/material"

import MathMarkdown from "./MathMarkdown"
import { PageComment } from "../PageDetail"

export interface DisplayCommentsProps {
    comments: PageComment[]
}

export default function DisplayComments(props: DisplayCommentsProps) {
    // const [addr, setAddr] = React.useState("");
    // const [content, setContent] = React.useState("");

    return (
        <Grid
            // direction="column"
            // alignItems="center"
            // textAlign="center"
            // justifyContent="center"
            spacing={1}
            container
            item
            xs={12}
            textAlign="left"
            alignItems="left"
            style={{
                maxWidth: "768px",
                margin: "0 auto",
                overflowWrap: "break-word",
                width: "100%",

            }}
        >
            {props.comments.map((comment, i) => {
                return (
                    <Grid
                        key={i}
                        item xs={12}
                        style={{
                            // maxWidth: "700px",
                            // margin: "0 auto",
                            // overflowWrap: "break-word",
                            margin: '0',
                            padding: '0',
                        }}
                    >
                        <Paper elevation={3} style={{
                            margin: "0",
                            padding: "1em",
                            // maxWidth: "700px",
                            // overflowWrap: "break-word",
                        }}>
                            <MathMarkdown content={comment.comment} />
                            <Divider />
                            <Typography textAlign={"right"}>
                                {
                                    new Date(
                                        comment.created_at
                                    ).toLocaleDateString("fr-CA")
                                    // Impose my favorite onn the world ^^^ YYYY-MM-DD
                                    // Maybe there is some better way though, IDK
                                    // toLocaleDateString
                                    // 'en-us', { year: "numeric", month: "long", day: "numeric" }
                                }
                            </Typography>
                        </Paper>
                        <Divider style={{ margin: "1.7em 1em 1em 1em" }} />
                    </Grid>
                )
            })}
        </Grid>
    )
}
