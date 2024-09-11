import {
    Card, CardHeader, Tooltip, Avatar,
    CardContent, CardActions, Link, Stack,
} from "@mui/material";
import moment from "moment";
import { useEffect } from "react";
import CommentVote from "./CommentVote";
import { CommentData } from "./DisplayThreadedComments";
import MathMarkdown from "./MathMarkdown";
import ThreadedCommentReplyAction from "./ThreadedCommentReplyAction";
import TransitionLink from "./TransitionLink";
import { KeyboardArrowUp, MoveUp } from "@mui/icons-material";

type Props = {
    comment: CommentData,
    object_type?: "zpage" | "ai_conversation",
    object_uuid?: string,
    setReload: React.Dispatch<React.SetStateAction<number>>
    top?: boolean
}


export default function CommentCard(props: Props) {
    const { comment, object_type, object_uuid, setReload, top } = props

    useEffect(() => {
        const hash = window.location.hash
        if (hash) {
            const id = hash.substring(1)
            if (id === `comment-${comment.uuid}`) {
                setTimeout(() => {
                    const element = document.getElementById(id)
                    if (element) {
                        element.scrollIntoView({ behavior: 'smooth' })
                    }
                }, 5000)
            }
        }
    }, [])

    return (
        <Card
            style={{
                minWidth: "300px",
            }}
            id={`comment-${comment.uuid}`}
        >
            <CardHeader
                avatar={
                    <Tooltip title={`See more from ${comment.author.username}`}>
                        <Link
                            to={`/${comment.author.username}`}
                            target="_blank"
                            component={TransitionLink}
                        >
                            <Avatar
                                src={comment.author.avatar_image?.thumbnail || '/tuzi.svg'}
                            />
                        </Link>
                    </Tooltip>
                }
                title={comment.headline}
                subheader={
                    <Link
                        style={{
                            textDecoration: 'none',

                        }}
                        to={`/converse/${comment.uuid}`}
                        component={TransitionLink}
                    >
                        {moment(comment.created_at).fromNow()}
                    </Link>
                }
                action={
                    <Stack
                        direction="column"
                        alignContent={"center"}
                        justifyContent={"center"}
                        alignItems={"center"}
                    >
                        <CommentVote
                            comment={comment}
                            setReload={setReload}
                        />
                        <Stack direction="row" spacing={1}>
                            {top && comment.content_url &&
                                <Tooltip title="Navigate to content">
                                    <Link
                                        to={comment.content_url}
                                        component={TransitionLink}
                                    >
                                        <MoveUp fontSize="small" />
                                    </Link>
                                </Tooltip>
                            }
                            {top && comment.parent &&
                                <Tooltip title="Navigate to parent">
                                    <Link
                                        to={`/converse/${comment.parent}`}
                                        component={TransitionLink}
                                    >
                                        <KeyboardArrowUp fontSize="small" />
                                    </Link>
                                </Tooltip>
                            }
                        </Stack>
                    </Stack>
                }
            />
            <CardContent
                style={{
                    padding: "0px 20px",
                }}
            >
                <MathMarkdown
                    content={comment.content}
                />
            </CardContent>
            <CardActions>
                <ThreadedCommentReplyAction
                    comment={comment}
                    object_type={object_type}
                    object_uuid={object_uuid}
                    setReload={setReload}
                />
            </CardActions>
        </Card>
    )
}