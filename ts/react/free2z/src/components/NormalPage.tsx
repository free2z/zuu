import { Grid } from "@mui/material";

type Props = {
    children: JSX.Element,
};

const NormalPageStyles = {
    marginTop: "3em",
    padding: "0px 7px",
    // width: "100%",
};

export default function NormalPage({ children }: Props) {
    return (
        <>
            <Grid
                container
                spacing={0}
                direction="row"
                alignItems="center"
                textAlign="center"
                justifyContent="center"
                style={NormalPageStyles}
            >
                <Grid item container xs={12} sm={11} md={10} lg={8} xl={7}>
                    {children}
                </Grid>
            </Grid>
        </>
    )
}