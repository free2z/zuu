import { Cancel } from "@mui/icons-material"
import { Stack, TextField, InputAdornment, IconButton, Pagination } from "@mui/material"
import axios from "axios"
import { useEffect, useState } from "react"
import { FeaturedImage } from "./PageRenderer"


type MyUploadsSearchProps = {
    // can force reload by changing
    loads?: number
    setResults: React.Dispatch<React.SetStateAction<FeaturedImage[]>>
    extraQuery?: string
    setSearching: React.Dispatch<React.SetStateAction<boolean>>
}

export default function MyUploadsSearch(props: MyUploadsSearchProps) {
    const { loads, setResults, extraQuery, setSearching } = props
    const [prev, setPrev] = useState(null)
    const [next, setNext] = useState(null)
    const [page, setPage] = useState(1)
    const [count, setCount] = useState(0)
    const [search, setSearch] = useState("")

    const handleChange = (event: React.ChangeEvent<unknown>, value: number) => {
        setPage(value);
    };

    useEffect(() => {
        setSearching(true)
        setResults([] as FeaturedImage[])
        axios.get(
            `/api/myuploads/?page=${page}&search=${search}&${extraQuery}`
        ).then((res) => {
            // console.log("SETTING META TO", res.data.results)
            setResults(res.data.results)
            setCount(res.data.count)
            setPrev(res.data.previous)
            setNext(res.data.next)
            setSearching(false)
        }).catch((err) => {
            console.error("Failed to search", err)
            setSearching(false)
        })
    }, [loads, page, search])

    return (
        <Stack
            style={{
                marginTop: "1em",
            }}
            direction="column"
            alignItems="center"
            spacing={1}
        >
            <TextField
                // disabled={!count && !search}
                type="text"
                value={search}
                onChange={(ev) => {
                    setPage(1)
                    setSearch(ev.target.value)
                }}
                placeholder="Search"
                fullWidth
                variant="outlined"
                InputProps={{
                    endAdornment: (
                        <InputAdornment position="start">
                            {search.length > 0 && (
                                <IconButton
                                    size="large"
                                    onClick={() => {
                                        setSearch("")
                                    }}
                                >
                                    <Cancel color="secondary" />
                                </IconButton>
                            )}
                        </InputAdornment>
                    )
                }}
            />
            <Pagination
                // defaultValue={1}
                size="small"
                page={page}
                count={Math.ceil(count / 12)}
                variant="outlined"
                color="primary"
                onChange={handleChange}
            />
        </Stack>
    )
}
