import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { useQuery, useQueryClient } from "react-query";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { getGlobalState, useGlobalState } from "../state/global";
import { moderationCopy } from "./moderationCopy";

const reasons = [
  "csae",
  "harassment",
  "hate",
  "sexual",
  "violence",
  "spam",
  "other",
];
const keyFor = (actor: number, epoch: number) => [
  "moderation-blocks",
  actor,
  epoch,
];
export function useUnblockRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("free2z-unblocked", refresh);
    return () => window.removeEventListener("free2z-unblocked", refresh);
  }, []);
  return revision;
}
const activeActor = () =>
  (getGlobalState("authStatus") && getGlobalState("creator").id) || 0;

async function readBlocks(
  actor: number,
  epoch: number,
  signal?: AbortSignal
): Promise<string[]> {
  let page = 1;
  const names: string[] = [];
  let pages = 1;
  do {
    if (
      activeActor() !== actor ||
      getGlobalState("authEpoch") !== epoch ||
      signal?.aborted
    )
      throw new Error("Session changed");
    const { data } = await axios.get("/api/g12f/blocks/mine/", {
      params: { page, page_size: 48 },
      signal,
    });
    if (
      activeActor() !== actor ||
      getGlobalState("authEpoch") !== epoch ||
      signal?.aborted
    )
      throw new Error("Session changed");
    if (
      !data ||
      !Array.isArray(data.results) ||
      !Number.isSafeInteger(data.count) ||
      data.count < 0 ||
      data.results.some(
        (row: { username?: unknown }) =>
          typeof row?.username !== "string" || !row.username
      )
    )
      throw new Error("Invalid block list");
    names.push(
      ...data.results.map((row: { username: string }) => row.username)
    );
    pages = Math.max(pages, Math.ceil(data.count / 48));
    if (data.next !== null && typeof data.next !== "string")
      throw new Error("Invalid block list");
    if (!data.next) {
      if (names.length !== data.count) throw new Error("Incomplete block list");
      break;
    }
    if (page >= pages) throw new Error("Invalid block pagination");
    page++;
  } while (page <= pages);
  return names;
}

export function useBlocks() {
  const [creator] = useGlobalState("creator");
  const [auth] = useGlobalState("authStatus");
  const [epoch] = useGlobalState("authEpoch");
  const actor = auth && creator.id ? creator.id : 0;
  const client = useQueryClient();
  const previousActor = useRef({ actor, epoch });
  useEffect(() => {
    const previous = previousActor.current;
    previousActor.current = { actor, epoch };
    if (
      previous.actor &&
      (previous.actor !== actor || previous.epoch !== epoch)
    ) {
      client.cancelQueries(keyFor(previous.actor, previous.epoch));
      client.removeQueries(keyFor(previous.actor, previous.epoch));
    }
  }, [actor, epoch, client]);
  const query = useQuery(
    keyFor(actor, epoch),
    ({ signal }) => readBlocks(actor, epoch, signal),
    {
      enabled: !!actor,
      retry: false,
      staleTime: 30000,
    }
  );
  return { actor, epoch, query };
}

function validateBlockResponse(
  data: unknown,
  username: string,
  active: boolean
) {
  const value = data as { username?: unknown; active?: unknown } | null;
  if (
    typeof value?.username !== "string" ||
    value.username.toLowerCase() !== username.toLowerCase() ||
    value.active !== active
  )
    throw new Error("Invalid block response");
}

export function BlockedContent({
  username,
  children,
}: {
  username: string;
  children: React.ReactNode;
}) {
  const { query } = useBlocks();
  const copy = moderationCopy();
  if (
    query.data?.some((name) => name.toLowerCase() === username.toLowerCase())
  ) {
    return <Alert severity="info">{copy[4]}</Alert>;
  }
  return <>{children}</>;
}

export function ModerationControls({
  username,
  kind,
  targetId,
}: {
  username: string;
  kind: "comment" | "zpage" | "creator";
  targetId: string;
}) {
  const { actor, epoch, query } = useBlocks();
  const client = useQueryClient();
  const copy = moderationCopy();
  const [reportOpen, setReportOpen] = useState(false);
  const [reason, setReason] = useState(reasons[0]);
  const [details, setDetails] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [uiEpoch, setUiEpoch] = useState(epoch);
  const sameSession = uiEpoch === epoch;
  useEffect(() => {
    setUiEpoch(epoch);
    setReportOpen(false);
    setPending(false);
    setMessage("");
    setDetails("");
  }, [actor, epoch]);
  const blocked =
    query.data?.some((name) => name.toLowerCase() === username.toLowerCase()) ||
    false;
  if (
    !actor ||
    getGlobalState("creator").username.toLowerCase() === username.toLowerCase()
  )
    return null;
  const change = async () => {
    const current = () =>
      activeActor() === actor && getGlobalState("authEpoch") === epoch;
    setPending(true);
    setMessage("");
    try {
      const response = await axios({
        method: blocked ? "delete" : "put",
        url: `/api/creator/${encodeURIComponent(username)}/block/`,
      });
      if (!current()) return;
      validateBlockResponse(response.data, username, !blocked);
      await client.cancelQueries(keyFor(actor, epoch));
      if (!current()) return;
      client.setQueryData<string[]>(keyFor(actor, epoch), (old) =>
        blocked
          ? (old || []).filter(
              (name) => name.toLowerCase() !== username.toLowerCase()
            )
          : [...(old || []), username]
      );
      if (blocked) {
        window.dispatchEvent(new Event("free2z-unblocked"));
        await client.invalidateQueries();
      }
    } catch {
      if (current()) setMessage(copy[9]);
    } finally {
      if (current()) setPending(false);
    }
  };
  const report = async () => {
    const current = () =>
      activeActor() === actor && getGlobalState("authEpoch") === epoch;
    setPending(true);
    setMessage("");
    try {
      await axios.post("/api/reports/", {
        target_kind: kind,
        target_id: targetId,
        reason,
        details,
      });
      if (!current()) return;
      setReportOpen(false);
      setMessage(copy[10]);
    } catch {
      if (current()) setMessage(copy[9]);
    } finally {
      if (current()) setPending(false);
    }
  };
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1}>
        <Button
          onClick={() => setReportOpen(true)}
          disabled={!sameSession || pending}
        >
          {copy[0]}
        </Button>
        <Button
          onClick={change}
          disabled={!sameSession || pending || query.isLoading || query.isError}
        >
          {blocked ? copy[2] : copy[1]}
        </Button>
      </Stack>
      {sameSession && message && !reportOpen && (
        <Typography role="status">{message}</Typography>
      )}
      <Dialog
        open={sameSession && reportOpen}
        onClose={() => setReportOpen(false)}
      >
        <DialogTitle>{copy[0]}</DialogTitle>
        <DialogContent>
          {message && <Alert severity="error">{message}</Alert>}
          <TextField
            select
            fullWidth
            margin="normal"
            label={copy[11]}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            {reasons.map((value, i) => (
              <MenuItem key={value} value={value}>
                {copy[15 + i]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            multiline
            margin="normal"
            label={copy[12]}
            value={details}
            inputProps={{ maxLength: 2000 }}
            onChange={(e) => setDetails(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReportOpen(false)}>{copy[14]}</Button>
          <Button disabled={pending} onClick={report}>
            {copy[13]}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export function BlockManagement() {
  const { actor, epoch, query } = useBlocks();
  const client = useQueryClient();
  const copy = moderationCopy();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState(false);
  const [uiEpoch, setUiEpoch] = useState(epoch);
  const sameSession = uiEpoch === epoch;
  useEffect(() => {
    setUiEpoch(epoch);
    setOpen(false);
    setPending("");
    setError(false);
  }, [actor, epoch]);
  const unblock = async (name: string) => {
    const current = () =>
      activeActor() === actor && getGlobalState("authEpoch") === epoch;
    setPending(name);
    setError(false);
    try {
      const response = await axios.delete(
        `/api/creator/${encodeURIComponent(name)}/block/`
      );
      if (!current()) return;
      validateBlockResponse(response.data, name, false);
      await client.cancelQueries(keyFor(actor, epoch));
      if (!current()) return;
      client.setQueryData<string[]>(keyFor(actor, epoch), (old) =>
        (old || []).filter((item) => item.toLowerCase() !== name.toLowerCase())
      );
      window.dispatchEvent(new Event("free2z-unblocked"));
      await client.invalidateQueries();
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) setPending("");
    }
  };
  if (!actor) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>{copy[3]}</Button>
      <Dialog open={sameSession && open} onClose={() => setOpen(false)}>
        <DialogTitle>{copy[3]}</DialogTitle>
        <DialogContent>
          {query.isLoading && <Typography>{copy[5]}</Typography>}
          {query.isError && (
            <Alert severity="error">
              {copy[6]}{" "}
              <Button onClick={() => query.refetch()}>{copy[7]}</Button>
            </Alert>
          )}
          {error && <Alert severity="error">{copy[9]}</Alert>}
          {query.data && !query.data.length && (
            <Typography>{copy[8]}</Typography>
          )}
          {query.data?.map((name) => (
            <Stack
              key={name}
              direction="row"
              alignItems="center"
              justifyContent="space-between"
            >
              <Typography>@{name}</Typography>
              <Button disabled={!!pending} onClick={() => unblock(name)}>
                {copy[2]}
              </Button>
            </Stack>
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{copy[22]}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
