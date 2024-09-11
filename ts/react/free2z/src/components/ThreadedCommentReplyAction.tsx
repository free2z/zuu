import React, { useState } from "react"
import { PageInterface } from "./PageRenderer"
import { CommentData } from "./DisplayThreadedComments"
import { Accordion, AccordionDetails, AccordionSummary, Typography } from "@mui/material"
import { Quickreply } from "@mui/icons-material"
import CommentForm from "./CommentForm"

interface Props {
    comment: CommentData
    // zpage?: PageInterface
    object_type?: "zpage" | "ai_conversation"
    object_uuid?: string
    setReload: React.Dispatch<React.SetStateAction<number>>

}

export default function ThreadedCommentReplyAction(props: Props) {
    const { comment, object_type, object_uuid, setReload } = props

    const [formOpen, setFormOpen] = useState(false)

    const callback = () => {
        setFormOpen(false)
        setReload(Math.random())
    }

    return (
        <Accordion
            style={{
                width: "100%",
            }}
            elevation={1}
            expanded={formOpen}
            onChange={() => {
                setFormOpen(!formOpen)
            }}
        >
            <AccordionSummary
                expandIcon={
                    <Quickreply
                        color="primary"
                    />
                }
                aria-controls="panel1a-content"
                id="panel1a-header"
            >
                <Typography
                    color="primary"
                >Reply</Typography>
            </AccordionSummary>
            <AccordionDetails>
                <CommentForm
                    callback={callback}
                    object_type={object_type}
                    object_uuid={object_uuid}
                    parent={comment.uuid}
                />
            </AccordionDetails>
        </Accordion>
    )
}
