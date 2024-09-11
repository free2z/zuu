import { Dialog, IconButton, List, MenuItem, Popover, Stack, styled, useMediaQuery, useTheme } from "@mui/material"
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import { Fragment, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Content, Root, Paragraph, List as MDList, Text as MDText } from "mdast"

import DialogBackdrop from "../common/DialogBackdrop";
import CloseIcon from "@mui/icons-material/Close"


type TocItemProps = {
  item: any;
  handleClose: any;
  depth?: number;
}


const TocMenuItem = ({ item, handleClose, depth = 0 }: TocItemProps) => {
  const renderChildren = (children: any[], depth: number) => {
    return children.map((child: any, index: number) => (
      <TocMenuItem key={index} item={child} handleClose={handleClose} depth={depth + 1} />
    ));
  };

  switch (item.type) {
    case 'list':
      return <List>{renderChildren(item.children || [], depth)}</List>;
    case 'listItem':
      return <>{renderChildren(item.children || [], depth)}</>;
    case 'paragraph':
      return <>{renderChildren(item.children || [], depth)}</>;
    case 'link':
      return (
        <MenuItem style={{ textDecoration: "none" }}>
          <NavItem
            href={item.url}
            onClick={handleClose}
            depth={depth}
          >
            {renderChildren(item.children || [], depth)}
          </NavItem>
        </MenuItem>
      );
    case 'text':
      return <span>{item.value}</span>;
    default:
      return null;
  }
}

// A bit of hack, but seems to work and fix bugs like h5 before h4
function flattenText(nodes: any[]): string {
  let text = "";
  nodes.forEach(node => {
    if (node.type === "text") {
      text += node.value;
    } else if (node.type === "strong") {
      // Handle strong/bold formatting with nested children
      text += node.value || flattenText(node.children);
    }
  });
  return text;
}

function flattenMarkdownAST(ast?: Content[], depth = 0) {
  const flattened: any = [];

  ast?.forEach((node) => {
    if (node.type === "listItem") {
      const linkNode = node.children.find((child: any) => child.type === "paragraph" && child.children[0].type === "link") as Paragraph | undefined;
      if (linkNode && linkNode && linkNode.children[0].type === "link") {
        const link = linkNode.children[0];
        const menuItem = {
          text: (link.children[0] as MDText)?.value,
          url: link.url,
          depth: depth,
          bold: false,
        };
        if (depth === 0) {
          menuItem.bold = true; // Apply bold styling for h1 elements
        }
        if (!menuItem.text) {
          menuItem.text = flattenText(link.children);
        }
        flattened.push(menuItem);
      }

      const nestedList = node.children.find((child: any) => child.type === "list") as MDList | undefined;
      if (nestedList) {
        flattened.push(...flattenMarkdownAST(nestedList.children, depth + 1));
      }
    }
  });

  return flattened;
}

const scrollIntoViewWithOffset = (id: any, offset: number) => {
  const element = document.getElementById(id);
  if (!element?.getBoundingClientRect()?.top) { return; }
  const y = element?.getBoundingClientRect()?.top + window.scrollY + -offset;
  (typeof window !== 'undefined' ? window : undefined)?.scrollTo({ top: y, behavior: 'smooth' });
}

interface NavItemProps {
  active?: boolean;
  secondary?: boolean;
  secondarySubItem?: boolean;
  depth?: number
}


const NavItem = styled('a', {
  shouldForwardProp: (prop) =>
    !['active', 'depth'].includes(prop as string),
})<NavItemProps>(({ active, depth, theme }: any) => {
  let paddingLeft: string | number = '8px';
  if (depth >= 1) {
    paddingLeft = `${8 + (depth * 8)}px`;
  }

  return [
    {
      flex: 1,
      textDecoration: 'none',
      boxSizing: 'border-box',
      padding: theme.spacing('4px', 0, '4px', paddingLeft),
      borderLeft: `1px solid transparent`,
      display: 'flex',
      fontSize: theme.typography.pxToRem(13),
      fontWeight: theme.typography.fontWeightMedium,
      textOverflow: 'ellipsis',
      overflow: 'hidden',
      // '&:hover': {
      //     borderLeftColor: theme.palette.grey[400],
      //     color: theme.palette.grey[600],
      // },
      ...(!active && {
        color: theme.palette.text.primary,
      }),
      // ...(active && activeStyles),
      // '&:active': activeStyles,
    },

  ];
});

type HandleClose = (event: React.MouseEvent<HTMLLIElement>) => void

const MenuList = ({ data, handleClose }: { data: Root, handleClose: HandleClose }) => {
  const items = flattenMarkdownAST(data.children);
  const navigate = useNavigate();

  return (
    <>
      {items.map((item: any, index: number) => !item.text ? <Fragment key={index} /> : (
        <MenuItem onClick={(e) => {
          handleClose(e);

          const id = item.url.replace('#', '');
          scrollIntoViewWithOffset(id, 64);
          navigate(item.url)
        }} style={{ textDecoration: "none" }}
          key={index}
        >
          <NavItem
            href={item.url}
            onClick={(e) => e.preventDefault()}
            depth={item.depth}
            active={false}
          >
            {item.text}
            {/* {renderChildren(item.children || [], depth)} */}
          </NavItem>
        </MenuItem>
      ))}
    </>
  )
}


const TableOfContents = ({ toc }: { toc: any }) => {
  const theme = useTheme()
  const isXS = useMediaQuery('(max-width:330px)');
  const isSmall = useMediaQuery(theme.breakpoints.down('sm'))
  const isSmallHeight = useMediaQuery('(max-height:560px)')
  const [open, setOpen] = useState(false)
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);


  const handleClose = () => {
    setOpen(false);
    setAnchorEl(null);
  };

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setOpen(true)
    setAnchorEl(event.currentTarget)
  };

  // const handlePopoverClose = () => {
  //   setAnchorEl(null);
  // };


  const contents = <MenuList data={toc} handleClose={handleClose} />

  return (
    <>
      <IconButton
        onClick={handleClick}
      >
        <FormatListBulletedIcon fontSize="medium" />
        {/* Table of Contents */}
      </IconButton>
      {isSmall ? (
        <Dialog
          sx={{
            '& .MuiBackdrop-root': {
              backdropFilter: 'blur(16px)',
            },
          }}
          open={open}
          onClose={handleClose}
          slots={{ backdrop: DialogBackdrop }}
          fullScreen={isXS}
          fullWidth={true}
          maxWidth="sm"
        >
          {Boolean(isXS || isSmallHeight) && (
            <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
              <CloseIcon sx={{ fontSize: 40 }} onClick={handleClose} />
            </div>
          )}
          <Stack
            p="20px"
            mt={Boolean(isXS || isSmallHeight) ? "40px" : undefined}
            sx={{ maxHeight: (!Boolean(isXS || isSmallHeight) && isSmall) ? "80vh" : undefined }}
          >
            {contents}
          </Stack>
        </Dialog>
      ) : (
        <Popover
          // id="simple-menu"
          anchorEl={anchorEl}
          keepMounted
          open={Boolean(anchorEl)}
          onClose={handleClose}
          style={{
            alignItems: 'center',
            justifyContent: 'center',
          }}
          anchorOrigin={{
            vertical: 'bottom',
            horizontal: 'left',
          }}
          transformOrigin={{
            vertical: 'top',
            horizontal: 'left',
          }}
        >
          <Stack p="20px" width="400px">
            {contents}
          </Stack>
        </Popover>
      )}
    </>
  )
}

export default TableOfContents
