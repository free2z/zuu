import { Diversity3, PrivacyTip, Public } from "@mui/icons-material"
import { ImageListItem, ImageListItemBar, IconButton, Link, Box } from "@mui/material"
import { useState } from "react"
import ReactPlayer from 'react-player/lazy'
import { FileMetadata } from "./DragDropFiles"
import UploadEditDialog from "./UploadEditDialog"


type FileImageListItemProps = {
    file: FileMetadata,
    setLoads: React.Dispatch<React.SetStateAction<number>>,
}

function getIcon(file: FileMetadata) {
    let Icon = Public
    if (file.access == "members") {
        Icon = Diversity3
    } else if (file.access == "private") {
        Icon = PrivacyTip
    }
    return Icon
}


export function FileItem(props: { file: FileMetadata }) {
    const { file } = props

    const Icon = getIcon(file)

    if (!file.url) {
        return null
    }


    if (file.mime_type?.startsWith('video') || file.mime_type?.startsWith('audio')) {
        return (
            <Box component="div"
                style={{
                    // width: '100%',
                    // height: 'auto',
                    // maxHeight: '100%',
                    margin: "0 auto",
                    // zIndex: 10000,
                    // maxWidth: "200px",
                    // height: "100%",
                    // maxWidth: "100%",
                    display: 'flex',
                    alignItems: 'flex-end', // This will push ReactPlayer to the bottom
                    justifyContent: 'center',
                }}
            >
                <ReactPlayer
                    style={{
                        // width: '100%',
                        // height: 'auto',
                        // maxHeight: '100%',
                        margin: "0 auto",
                        // zIndex: 10000,
                        maxWidth: "150px",
                        // maxWidth: "100%",
                        maxHeight: "130px",
                    }}
                    url={`${file.url}`}
                    controls={true}
                />
            </Box>
        )
    } else if (file.mime_type?.startsWith('image')) {
        return <img
            src={`${file.thumbnail || file.url}`}
            srcSet={`${file.thumbnail}`}
            alt={file.title || file.name}
            // loading="lazy"
            // style={{
            //     maxWidth: "150px",
            //     height: "130px",
            // }}
            style={{ width: '100%', height: 'auto' }}
            onError={(e) => {
                if (e.currentTarget.src !== "/tuzi.svg") {
                    e.currentTarget.onerror = null
                    e.currentTarget.src = "/tuzi.svg"
                    e.currentTarget.srcset = "/tuzi.svg"
                }
            }}
        />
    }
    // Make some space
    return <img
        src="/tuzi.svg"
        srcSet="/tuzi.svg"
        alt={file.title || file.name}
        loading="lazy"
        // style={{
        //     maxWidth: "150px",
        //     height: "130px",
        // }}
        style={{ width: '100%', height: 'auto' }}
    />
}

export default function FileImageListItem(props: FileImageListItemProps) {
    const [open, setOpen] = useState(false)
    const { file, setLoads } = props
    const Icon = getIcon(file)

    return (
        <ImageListItem
            style={{
                // maxWidth: "100%",
                // maxHeight: "200px",
                // minHeight: "20em",
                width: "100%",
                // height: "150px",
            }}
        >
            <ImageListItemBar
                position="top"
                style={{
                    // fragile - above video controls but below dialog ;/
                    zIndex: 1000,
                }}
                title={
                    <Link
                        href={file.url}
                        target="_blank"
                        sx={{
                            color: "warning.light"
                        }}
                    >
                        {file.title || file.name}
                    </Link>}
                subtitle={file.name}
                actionIcon={
                    <IconButton
                        onClick={() => {
                            setOpen(true)
                        }}
                        color="info"
                    >
                        <Icon />
                    </IconButton>
                }
            />
            <Box
                component="div"
            >
                <FileItem
                    file={file}
                />
            </Box>
            <UploadEditDialog
                open={open}
                setOpen={setOpen}
                file={file}
                setLoads={setLoads}
            />

        </ImageListItem>
    )
}
