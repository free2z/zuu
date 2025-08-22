// state/global.tsx
import { ReactNode } from "react";
import { AlertColor } from "@mui/material";
import { createGlobalState } from "react-hooks-global-state";
import { Creator } from "../Begin";
import { FeaturedImage } from "../components/PageRenderer";

export const defaultCreator = {
    username: "",
    full_name: "",
    p2paddr: "",
    description: "",
    //
    email: "",
    first_name: "",
    last_name: "",
    total: 0,
    tuzis: "0",
    updateAll: false,
    stars: [],
    fans: [],
    is_verified: false,
    can_stream: false,
    member_price: "1",
    zpages: 0,
    avatar_image: null as FeaturedImage | null,
    banner_image: null as FeaturedImage | null,
} as Creator;

// Optional action for the snackbar; all fields optional.
export interface SnackbarAction {
    render?: (ctx: { key: any; close: () => void }) => ReactNode;
    onClick?: () => void | Promise<void>;
    icon?: ReactNode;
    ariaLabel?: string;
}

export interface SnackbarState {
    open: boolean;
    message: string;
    severity?: AlertColor;
    duration?: number | null;
    action?: SnackbarAction; // optional
}

export const { useGlobalState } = createGlobalState({
    creator: defaultCreator,
    snackbar: {
        open: false,
        severity: "success" as AlertColor,
        message: "",
        duration: undefined as number | null | undefined,
        // action omitted by default
    } as SnackbarState,
    loading: false,
    loadingEmbed: false,
    redirect: "",
    loginModal: false,
    authStatus: null as boolean | null,
    unreadCount: null as number | null,
});
