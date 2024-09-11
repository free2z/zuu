import { useEffect, useState } from "react"
import ImageList from '@mui/material/ImageList';
import FileImageListItem from "./FileImageListItem"
import MyUploadsSearch from "./MyUploadsSearch";
import { FeaturedImage } from "./PageRenderer";
import { Typography } from "@mui/material";

type MyUploadsProps = {
    loads: number,
    setLoads: React.Dispatch<React.SetStateAction<number>>,
}

export default function MyUploads(props: MyUploadsProps) {

    const { loads, setLoads } = props
    const [results, setResults] = useState([] as FeaturedImage[])
    const [mql, setMQL] = useState(window.matchMedia('(max-width: 600px)'))
    const [searching, setSearching] = useState(true)

    useEffect(() => {
        window.addEventListener('resize', () => {
            setMQL(window.matchMedia('(max-width: 600px)'));
        })
    }, [])

    return (
        <>
            <MyUploadsSearch
                setSearching={setSearching}
                loads={loads}
                setResults={setResults}
            />
            {results.length === 0 && !searching &&
                <Typography variant="h6" sx={{ textAlign: "center" }}>No results</Typography>
            }
            <ImageList
                cols={mql.matches ? 2 : 3}
                variant="masonry"
                style={{
                    padding: "0.5em 0",
                    minHeight: "500px",
                }}
            >
                {results.map((fmd, i) => (
                    <FileImageListItem
                        file={fmd}
                        setLoads={setLoads}
                        key={i}
                    />
                ))}
            </ImageList>
        </>
    );
}
