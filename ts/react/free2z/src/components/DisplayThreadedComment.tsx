import { useState } from "react"
import { CommentData } from "./DisplayThreadedComments"
import { Paper } from "@mui/material"
import CommentCard from "./CommentCard"
import CommentChildren from "./CommentChildren"

interface Props {
    comment: CommentData
    object_type?: "zpage" | "ai_conversation"
    object_uuid?: string
    top?: boolean
}

const DisplayComment = (props: Props) => {
    const { comment, object_type, object_uuid, top } = props
    const [reload, setReload] = useState(comment.num_children)

    return (
        <Paper
            elevation={5}
        >
            <CommentCard
                comment={comment}
                setReload={setReload}
                top={top}
                object_type={object_type}
                object_uuid={object_uuid}
            />
            <CommentChildren
                reload={reload}
                parent={comment.uuid}
                comment={comment}
                object_type={object_type}
                object_uuid={object_uuid}
            />
        </Paper>
    )
}

export default DisplayComment
