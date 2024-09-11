import { Stack } from "@mui/material"
import axios from "axios"
import { useEffect, useState } from "react"
import DisplayComment from "./DisplayThreadedComment"
import { CommentData } from "./DisplayThreadedComments"

type Props = {
    object_uuid?: string
    object_type?: "zpage" | "ai_conversation"
    reload: number
    comment: CommentData
    parent?: string
}

export default function CommentChildren(props: Props) {
    const { object_type, object_uuid, reload, comment } = props
    const [children, setChildren] = useState<CommentData[]>([]);

    useEffect(() => {
        let url
        if (object_type && object_uuid) {
            url = `/api/comments/${object_type}/${object_uuid}/?parent=${comment.uuid}`
        } else {
            url = `/api/comments/${comment.uuid}/replies/`
        }

        const fetchChildrenComments = async (url: string) => {
            let accumulatedChildren: CommentData[] = [];

            try {
                let nextUrl = url;

                while (nextUrl) {
                    const res = await axios.get(nextUrl);
                    accumulatedChildren = [...accumulatedChildren, ...res.data.results];
                    nextUrl = res.data.next;
                }
            } catch (error) {
                console.error(error);
            }

            setChildren(accumulatedChildren);
        };

        fetchChildrenComments(url);
    }, [reload, comment.uuid, object_type, object_uuid]);

    return (
        <>
            {children.length > 0 && children.map((child) => (
                <Stack
                    key={child.uuid}
                    style={{
                        marginLeft: "0.5em",
                    }}
                >
                    <DisplayComment
                        key={child.uuid}
                        comment={child}
                        object_type={object_type}
                        object_uuid={object_uuid}
                    />
                </Stack>
            ))}
        </>
    )
}
