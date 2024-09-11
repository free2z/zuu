import { useParams } from "react-router-dom";
import { CommentData } from "./DisplayThreadedComments";
import { useEffect, useState } from "react";
import axios from "axios";
import { Grid } from "@mui/material";
import DisplayThreadedComment from "./DisplayThreadedComment";


export default function Converse() {
    const params = useParams()
    const parent = params.commentUUID

    const [comment, setComment] = useState({} as CommentData)

    useEffect(() => {
        axios.get(`/api/comments/${parent}/`).then(res => {
            // console.log("COMMENT", res)
            setComment(res.data)
        })
    }, [parent])

    if (!comment.uuid) {
        return null
    }

    return (
        <Grid
            textAlign="left"
            alignItems="center"
            justifyContent="center"
            width="100%"
            style={{
                overflowWrap: "break-word",
                overflowX: "auto",
                padding: "0.33em",
            }}
        >
            <DisplayThreadedComment
                comment={comment}
                top={true}
            />
        </Grid>
    )
}