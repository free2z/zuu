import { Stack, ButtonBase, Chip, Link, useTheme } from "@mui/material"
import { PageInterface } from "./PageRenderer"
import TransitionLink from "./TransitionLink"



type PageTagsProps = {
    page: PageInterface,
}

export default function PageTags(props: PageTagsProps) {
    const { page } = props
    const theme = useTheme()
    return (
        <Stack direction="row"
            style={{
                width: "100%",
                // maxWidth: "700px",
                marginTop: "0.25em",
                margin: "0 auto",
                flexWrap: "wrap",

            }}
            spacing={1}
            alignItems="center"
            justifyContent="center"
        >
            {page.tags.map((t) => {
                return (
                    <ButtonBase
                        key={t.name}
                    >
                        <Link
                            to={`/find?tags=${t.name}`}
                            component={TransitionLink}
                        >
                            <Chip
                                label={t.name}
                                sx={{
                                    cursor: "pointer",
                                    margin: "0.25em",
                                    "&:hover, &:active": {
                                        transform: "scale(1.05)",
                                        transition: "transform 0.2s ease-in-out",
                                        color: theme.palette.primary.main,
                                    },
                                }}
                            />

                        </Link>
                    </ButtonBase>

                )
            })}
        </Stack>
    )
}