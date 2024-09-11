import React, { useEffect, useRef, useState } from 'react';
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Button from "@mui/material/Button";
import axios from 'axios';
import { useQuery } from 'react-query';
import { useInView } from 'react-intersection-observer';
import {
  FormControl, ImageList, ImageListItem, ImageListItemBar, InputLabel,
  Link,
  MenuItem, Select, TextField, Typography,
} from '@mui/material';
import { FileItem } from './FileImageListItem';
import { FileMetadata } from './DragDropFiles';
import { ArrowDropDown } from '@mui/icons-material';

interface ApiResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: FileMetadata[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (file: FileMetadata) => void;
}

const FileSelectorDialog: React.FC<Props> = ({ open, onClose, onSelect }) => {
  const [data, setData] = useState<FileMetadata[]>([]);

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState('');
  const [mimeType, setMimeType] = useState('');
  const [mql, setMQL] = useState(window.matchMedia('(max-width: 600px)'))
  const [initialFetchCompleted, setInitialFetchCompleted] = useState(false);

  const manuallySetPageRef = useRef(false);


  const [ref, inView] = useInView({
    threshold: 0
  });

  useEffect(() => {
    window.addEventListener('resize', () => {
      setMQL(window.matchMedia('(max-width: 600px)'));
    })
  }, [])

  const fetchFiles = (page: number): Promise<ApiResponse> => {
    return axios.get(
      `/api/myuploads/?page=${page}&search=${search}&mime_type=${mimeType}&access=public`
    ).then(res => res.data);
  }

  const { data: newData, isError, isLoading } = useQuery<ApiResponse, unknown>(['myuploads', page, search, mimeType], () => fetchFiles(page), {
    keepPreviousData: true,
    onSuccess: (newData: ApiResponse) => {
      setData(prev => [...prev, ...newData.results]);
      setHasMore(!!newData.next);
      setInitialFetchCompleted(true)
    },
    onError: (err) => {
      setInitialFetchCompleted(true)
    }
  });

  useEffect(() => {
    if (inView && hasMore && !isLoading) {
      if (manuallySetPageRef.current) {
        manuallySetPageRef.current = false;  // Reset the flag
      } else {
        // console.log("setting page plus 1")
        setPage(prev => prev + 1);
      }
    }
  }, [inView, hasMore, isLoading]);

  return (
    <Dialog open={open} onClose={onClose}
      maxWidth="md"
      fullWidth
      fullScreen={mql.matches}
    >
      <DialogTitle>
        <TextField
          label="Search"
          variant="outlined"
          value={search}
          onChange={(e) => {
            manuallySetPageRef.current = true;
            setInitialFetchCompleted(false)
            setPage(1);
            setSearch(e.target.value);
            setData([]);
          }}
          fullWidth // to make the text field full width
          sx={{ marginBottom: 1 }} // spacing between the TextField and Select
        />
        <FormControl variant="outlined" fullWidth>
          <InputLabel id="mime-type-label">File Type</InputLabel>
          <Select
            labelId="mime-type-label"
            value={mimeType}
            onChange={(e) => {
              manuallySetPageRef.current = true;
              setInitialFetchCompleted(false)
              setPage(1);
              setMimeType(e.target.value as string);  // TypeScript type assertion
              setData([]);
            }}
            label="File Type"
          >
            <MenuItem value="">All</MenuItem>
            <MenuItem value="image">Images</MenuItem>
            <MenuItem value="video">Videos</MenuItem>
            <MenuItem value="audio">Audio</MenuItem>
            {/* <MenuItem value="file">Documents</MenuItem> */}
          </Select>
        </FormControl>
      </DialogTitle>

      <DialogContent
        sx={{
          minHeight: "60vh",
        }}
      >
        {data.length === 0 && initialFetchCompleted && (
          <Typography>
            No results!
            You can <Link href="/profile/uploads">upload</Link> some files?
          </Typography>
        )}
        <ImageList
          cols={mql.matches ? 2 : 3}
          gap={6}
          sx={{
            overflowY: 'visible',
          }}
        >

          {data.map((file) => (
            <ImageListItem key={file.id}
              // onClick={() => onSelect(file)}
              sx={{
                // cursor: "pointer",
                // minHeight: "200px",
                minWidth: "100px",
              }}
            >
              <ImageListItemBar
                position="top"
                onClick={() => {
                  onSelect(file)
                }}
                style={{
                  // fragile - above video controls but below dialog ;/
                  zIndex: 10000,
                  cursor: "pointer",
                }}
                title={
                  <Typography>{file.title || file.name}</Typography>
                }
                subtitle={file.name}
                actionIcon={
                  <ArrowDropDown color="info" />
                }
              />
              <FileItem key={file.id} file={file} />
            </ImageListItem>
          ))}
        </ImageList>
        {hasMore && <div ref={ref}>Loading more...</div>}
        {isError && <div>Error loading data</div>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="primary">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default FileSelectorDialog;
