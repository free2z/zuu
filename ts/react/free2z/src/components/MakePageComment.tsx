import React, { memo } from "react"

import {
    Grid,
    Paper,
    TextField,
    Typography,
    Link,
    InputAdornment,
} from "@mui/material"

import { getURI, current_f2z_address } from "../Constants"
import QRAddress from "./QRAddress"
import { QuestionMarkRounded } from "@mui/icons-material"
import MathMarkdown from "./MathMarkdown"
import TransitionLink from "./TransitionLink"
export interface MakePageCommentProps {
    free2zaddr: string
}

function MakePageComment(props: MakePageCommentProps) {
    const [content, setContent] = React.useState("")

    // console.log("MakePageComment", props.free2zaddr)

    return (
        <Grid
            // spacing={1}
            container
            // item xs={11}
            alignItems="center"
            justifyContent="center"
            style={{
                margin: "0 auto"
            }}
        >
            <Grid item xs={12}>
                <TextField
                    id="make-comment"
                    label="Zcash Comment"
                    type="textarea"
                    // variant='fullwidth'
                    error={content.length > 399}
                    multiline={true}
                    InputProps={{
                        endAdornment: (
                            <InputAdornment position="end">
                                <Link
                                    target="_blank"
                                    to="/flavored-markdown"
                                    component={TransitionLink}
                                >
                                    <QuestionMarkRounded color="info" />
                                </Link>
                            </InputAdornment>
                        ),
                    }}
                    // help
                    helperText={`Markdown Content ${content.length}/399`}
                    margin="dense"
                    // color={page.content ? "primary" : "error"}
                    color="primary"
                    // size="medium"
                    inputProps={{
                        style: {
                            fontSize: "larger",
                            fontFamily: "monospace",
                        },
                        // style: {
                        //   color: "transparent",
                        //   background: "transparent",
                        //   caretColor: "secondary", /* Or choose your favorite color */
                        // },
                    }} // font size of input text
                    minRows={6}
                    // style={{
                    //   minHeight: "10em"
                    //   rows: ""
                    // }}
                    fullWidth
                    // variant="standard"
                    value={content}
                    onChange={(v) => {
                        setContent(v.target.value)
                    }}
                    required={true}
                />
            </Grid>

            {content.length > 0 && (
                <>
                    <Grid item xs={12}>
                        <Paper elevation={3} style={{ padding: "1em" }}>
                            <Typography>Comment Preview</Typography>
                            <MathMarkdown content={content} />
                        </Paper>
                    </Grid>
                    <Grid item xs={12} style={{ marginBottom: "2em" }}>
                        <QRAddress
                            prompt="Make Comment"
                            // TODO: UPDATE Link - How to make comment?
                            docs="/docs/supporters/donating-with-zcash"
                            addr={getURI(
                                current_f2z_address,
                                "0.0001",
                                JSON.stringify({
                                    act: "page_comment",
                                    id: props.free2zaddr,
                                    comment: content,
                                })
                            )}
                            size={222}
                            showHelp={true}
                        />
                    </Grid>
                </>
            )}
        </Grid>
    )
}

export default memo(MakePageComment)
