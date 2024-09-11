
import { AccountBalance, Spa, VerifiedTwoTone } from "@mui/icons-material"
import {
    FormGroup,
    FormControlLabel,
    Switch,
    Tooltip,
} from "@mui/material"
import { PageQuery } from "./Find"

export interface FindSwitchesProps {
    // comments: PageComment[],
    pageQuery: PageQuery
    // setPageQuery: React.Dispatch<React.SetStateAction<PageQuery>>,
    setParams(q: PageQuery): void
}

export default function FindSwitches(props: FindSwitchesProps) {
    const { pageQuery, setParams } = props

    return (
        <FormGroup

        >
            <Tooltip title="Show Only Verified Pages">
                <FormControlLabel
                    labelPlacement="start"
                    label={
                        <VerifiedTwoTone
                            style={{ marginTop: "5px" }}
                            color="primary"
                        />
                    }
                    control={
                        <Switch
                            size="medium"
                            checked={pageQuery.noShowUnverified}
                            value={pageQuery.noShowUnverified}
                            onChange={() => {
                                setParams({
                                    ...pageQuery,
                                    noShowUnverified: !pageQuery.noShowUnverified,
                                    page: 1,
                                })
                                // const n = !showUnfunded
                                // setShowUnfunded(n)
                                // submit(search, pagen, n, showFunded)
                            }}
                            color="primary"
                        />
                    }
                />
            </Tooltip>
        </FormGroup>
    )
}
