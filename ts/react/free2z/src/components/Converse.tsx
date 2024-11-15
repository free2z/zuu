import { useParams } from "react-router-dom";
import { CommentData } from "./DisplayThreadedComments";
import { lazy, useEffect, useState } from "react";
import axios from "axios";
import { Grid } from "@mui/material";
import DisplayThreadedComment from "./DisplayThreadedComment";
const Global404 = lazy(() => import('../Global404'))

export default function Converse() {
    const params = useParams();
    const parent = params.commentUUID;
    const [isLoading, setLoading] = useState(true)
    const [comment, setComment] = useState<CommentData>({} as CommentData);

    useEffect(() => {
        axios.get(`/api/comments/${parent}/`).then(res => {
            setComment(res.data)
        }).catch(() => {
            // prevent error when comment is not found
        }).finally(() => {
            setLoading(false);
        })
    }, [parent])

    if (isLoading) return null
    if (!comment.uuid) return <Global404 />
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