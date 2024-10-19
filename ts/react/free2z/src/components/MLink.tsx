import React, { useState, useEffect } from "react";
import {
  Link,
  LinkProps,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Button,
  Checkbox,
  FormControlLabel,
} from "@mui/material";

type MLinkProps = Omit<LinkProps, "color"> &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "color">;

// Key for storing the user's preference in localStorage
const LOCAL_STORAGE_KEY = "dontShowExternalLinkWarning";

const checkIisInternalLink = (href: string | undefined) =>
  href?.startsWith("#") ||
  href?.startsWith("https://free2z.com/") ||
  href?.startsWith("https://free2z.cash/") ||
  false;

const MLink: React.FC<MLinkProps> = ({ href, ...props }) => {
  const [open, setOpen] = useState(false);
  const [externalLink, setExternalLink] = useState<string | null>(null);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const isInternalLink = checkIisInternalLink(href);

  useEffect(() => {
    const storedPreference = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (storedPreference === null) {
      localStorage.setItem(LOCAL_STORAGE_KEY, "false");
    }
    setDontShowAgain(storedPreference === "true");
  }, []);

  const handleClick = (
    event: React.MouseEvent<HTMLAnchorElement, MouseEvent>
  ) => {
    //check directly from localStorage if the user has opted out of the warning
    const storedPreference = localStorage.getItem(LOCAL_STORAGE_KEY);
    // If the link is external and the user hasn't opted out of the warning, show the dialog
    if (!isInternalLink && !(storedPreference === "true")) {
      event.preventDefault();
      setExternalLink(href || null);
      setOpen(true);
    }
  };

  const handleClose = (confirm: boolean) => {
    setOpen(false);
    if (confirm && externalLink) {
      window.open(externalLink, "_blank", "noopener,noreferrer");
    }
  };

  const handleCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    setDontShowAgain(checked);
    localStorage.setItem(LOCAL_STORAGE_KEY, checked.toString());
  };

  return (
    <>
      <Link
        href={href}
        target={isInternalLink ? undefined : "_blank"}
        rel={isInternalLink ? undefined : "noopener,noreferrer"}
        onClick={handleClick}
        {...props}
      />

      {/* Confirmation dialog */}
      <Dialog
        open={open}
        onClose={() => handleClose(false)}
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">
          Navigate to external link?
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="alert-dialog-description">
            You are about to navigate to
          </DialogContentText>
          <DialogContentText
            sx={{
              fontWeight: "bold",
              whiteSpace: "pre-wrap",
              wordWrap: "break-word",
              my: 1,
            }}
          >
            <Link
              href={externalLink || ""}
              target="_blank"
              rel="noopener,noreferrer"
              color="primary"
            >{externalLink}</Link>
          </DialogContentText>
          <DialogContentText
            sx={{
              fontWeight: "bold",
              my: 1,
            }}
          >
            Are you sure you want to proceed?
          </DialogContentText>
          <FormControlLabel
            control={
              <Checkbox
                checked={dontShowAgain}
                onChange={handleCheckboxChange}
              />
            }
            label="Don't show this warning again"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => handleClose(false)} color="info">
            Cancel
          </Button>
          <Button onClick={() => handleClose(true)} color="success" autoFocus>
            Continue
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default MLink;
