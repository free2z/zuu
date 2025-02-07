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

// Key for storing the user's preferences in localStorage
const TRUSTED_DOMAINS_KEY = "trustedExternalDomains";
const GLOBAL_WARNING_KEY = "dontShowExternalLinkWarning";

// Helper function to extract domain from URL
const getDomain = (url: string): string => {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return "";
  }
};

const checkIsInternalLink = (href: string | undefined) =>
  href?.startsWith("#") ||
  href?.startsWith("https://free2z.com/") ||
  href?.startsWith("https://free2z.cash/") ||
  false;

const MLink: React.FC<MLinkProps> = ({ href, ...props }) => {
  const [open, setOpen] = useState(false);
  const [externalLink, setExternalLink] = useState<string | null>(null);
  const [dontShowGlobally, setDontShowGlobally] = useState(false);
  const [trustDomain, setTrustDomain] = useState(false);
  const [currentDomain, setCurrentDomain] = useState<string>("");

  const isInternalLink = checkIsInternalLink(href);

  useEffect(() => {
    // init globlal preferences
    const globalPreference = localStorage.getItem(GLOBAL_WARNING_KEY);
    if (globalPreference === null) {
      localStorage.setItem(GLOBAL_WARNING_KEY, "false");
    }
    setDontShowGlobally(globalPreference === "true");

    //  init trusted domains
    const trustedDomains = localStorage.getItem(TRUSTED_DOMAINS_KEY);
    if (trustedDomains === null) {
      localStorage.setItem(TRUSTED_DOMAINS_KEY, JSON.stringify([]));
    }
  }, []);

  useEffect(() => {
    if (href) {
      const domain = getDomain(href);
      setCurrentDomain(domain);
      
      // Check if domain is trusted
      const trustedDomains = JSON.parse(localStorage.getItem(TRUSTED_DOMAINS_KEY) || "[]");
      setTrustDomain(trustedDomains.includes(domain));
    }
  }, [href]);

  const shouldSkipWarning = (): boolean => {
    const globalPreference = localStorage.getItem(GLOBAL_WARNING_KEY) === "true";
    const trustedDomains = JSON.parse(localStorage.getItem(TRUSTED_DOMAINS_KEY) || "[]");
    return globalPreference || (currentDomain && trustedDomains.includes(currentDomain));
  };

  const handleClick = (
    event: React.MouseEvent<HTMLAnchorElement, MouseEvent>
  ) => {
    if (!isInternalLink && !shouldSkipWarning()) {
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

  const handleGlobalCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    setDontShowGlobally(checked);
    localStorage.setItem(GLOBAL_WARNING_KEY, checked.toString());
  };

  const handleDomainCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    setTrustDomain(checked);
    
    const trustedDomains = JSON.parse(localStorage.getItem(TRUSTED_DOMAINS_KEY) || "[]");
    if (checked && currentDomain) {
      trustedDomains.push(currentDomain);
    } else {
      const index = trustedDomains.indexOf(currentDomain);
      if (index > -1) {
        trustedDomains.splice(index, 1);
      }
    }
    localStorage.setItem(TRUSTED_DOMAINS_KEY, JSON.stringify(trustedDomains));
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
            >
              {externalLink}
            </Link>
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
                checked={trustDomain}
                onChange={handleDomainCheckboxChange}
              />
            }
            label={`Trust all links from ${currentDomain}`}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={dontShowGlobally}
                onChange={handleGlobalCheckboxChange}
              />
            }
            label="Don't show any external link warnings"
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