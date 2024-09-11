import { Theme, darken, lighten } from "@mui/material";

export const elevateColor = (theme: Theme, color: string, elevation = 1) => {
  const manipulateFunc = theme.palette.mode === 'dark' ? lighten : darken;

  return manipulateFunc(color, elevation * 0.025)
}
