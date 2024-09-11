import {
    Card, CardHeader, Tooltip, Avatar,
    CardContent, CardActions, Link, Stack,
} from "@mui/material";
import { memo, useMemo } from "react";
import CommentVote from "./CommentVoteInfinite";
import { CommentData } from "./DisplayThreadedComments";
import MathMarkdown from "./MathMarkdown";
import TransitionLink from "./TransitionLink";
import { KeyboardArrowUp, MoveUp } from "@mui/icons-material";
import moment from "moment";

type Props = {
    comment: CommentData,
}

// Moved the static styles outside of the component.
const cardStyles = {
    minWidth: "300px",
    marginBottom: "1px",
};

const cardContentStyles = {
    padding: "0px 20px",
};

const linkStyles = {
    textDecoration: 'none',
};

function CommentCard(props: Props) {
    const { comment } = props;

    // Memoizing the generated date string.
    const relativeDate = useMemo(() => {
        return moment(comment.created_at).fromNow();
    }, [comment.created_at]);

    return (
        <Card
            style={cardStyles}
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
                        style={linkStyles}
                        to={`/converse/${comment.uuid}`}
                        component={TransitionLink}
                    >
                        {relativeDate}
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
                        />
                        <Stack direction="row" spacing={1}>
                            {comment.content_url &&
                                <Tooltip title="Navigate to content">
                                    <Link
                                        to={comment.content_url}
                                        component={TransitionLink}
                                    >
                                        <MoveUp fontSize="small" />
                                    </Link>
                                </Tooltip>
                            }
                            {comment.parent &&
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
            <CardContent style={cardContentStyles}>
                <MathMarkdown
                    content={comment.content}
                />
            </CardContent>
            <CardActions>
                {/* <ThreadedCommentReplyAction
                    comment={comment}
                    object_type={object_type}
                    object_uuid={object_uuid}
                    setReload={setReload}
                /> */}
            </CardActions>
        </Card>
    );
}

// You may consider adding a custom comparison function here if needed.
export default memo(CommentCard);
