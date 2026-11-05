import axios from "axios";
import { useState, useEffect } from "react";
import { FeaturedImage } from "./PageRenderer";
import DisplayThreadedComment from "./DisplayThreadedComment";
import { Paper } from "@mui/material";
import { useUnblockRevision } from "./Moderation";
import { getGlobalState, useGlobalState } from "../state/global";

export type CommentAuthor = {
  username: string;
  avatar_image?: FeaturedImage;
};

export type CommentData = {
  uuid: string;
  author: CommentAuthor;
  parent: string | null;
  headline: string;
  content: string;
  tuzis: number;
  created_at: string;
  updated_at: string;
  num_children: number;
  content_url: string | null;
};

interface Props {
  // ai_conversation_id?: string,
  // zpage?: PageInterface,
  object_type?: "zpage" | "ai_conversation";
  object_uuid?: string;
  parent?: string;
  reload?: number;
}

export default function DisplayThreadedComments(props: Props) {
  const { reload, parent, object_type, object_uuid } = props;
  // Double call because of strict mode hrmmm
  // console.log("props", reload, parent, object_type, object_uuid)
  const [comments, setComments] = useState([] as CommentData[]);
  const unblockRevision = useUnblockRevision();
  const [creator] = useGlobalState("creator");
  const [auth] = useGlobalState("authStatus");
  const [epoch] = useGlobalState("authEpoch");
  const actor = auth ? creator.id : 0;

  useEffect(() => {
    let active = true;
    let url;
    if (object_type && object_uuid) {
      url = `/api/comments/${object_type}/${object_uuid}/?parent__isnull=True`;
    } else {
      url = `/api/comments/${parent}/replies/`;
    }
    const fetchComments = async (url: string) => {
      // strictmode double calls :()
      // console.log("FETCH COMMENTS", reload, parent, object_type, object_uuid)
      try {
        const res = await axios.get(url);
        if (!active || getGlobalState("authEpoch") !== epoch) return;
        setComments((prevComments) => [...prevComments, ...res.data.results]);

        if (res.data.next) {
          fetchComments(res.data.next);
        }
      } catch (error) {
        console.error(error);
        // TODO: snackbar
      }
    };

    setComments([]); // Clear previous comments before fetching new ones
    // console.log("GET COMMENTS");
    fetchComments(url);
    return () => {
      active = false;
    };
  }, [reload, parent, object_type, object_uuid, unblockRevision, actor, epoch]);

  if (!comments.length) {
    return null;
  }

  return (
    <Paper
      style={{
        margin: "0.33em",
      }}
      elevation={1}
    >
      {comments.map((comment, i) => (
        <DisplayThreadedComment
          // key={comment.uuid}
          key={i}
          comment={comment}
        />
      ))}
    </Paper>
  );
}
