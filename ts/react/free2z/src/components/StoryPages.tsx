import { Card, CardContent, CardMedia, Typography, useMediaQuery } from "@mui/material"
import { Story } from "./StoryTimeEdit"

type Props = {
    story: Story
}


export default function StoryPages(props: Props) {
    const { story } = props
    const smallScreen = useMediaQuery("(max-width: 600px)");

    if (!story.pages) {
        return null
    }

    return (
        <>
            {story.pages.map((page, index) => (
                <Card key={index}
                    style={{
                        marginTop: "0.5em",
                        textAlign: "left",
                    }}
                    elevation={15}
                >
                    <CardContent>
                        <Typography
                            color="textSecondary" gutterBottom
                            variant="caption"
                            textAlign="center"
                        >
                            {page.prompt}
                        </Typography>
                        {!!page.image_url &&
                            <>
                                <CardMedia
                                    style={{
                                        width: "100%",
                                        height: smallScreen ? "256px" : "512px",
                                    }}
                                    image={page.image_url}
                                />
                            </>
                        }
                        {!!page.content &&
                            <Typography variant="body2" component="p">
                                {page.content}
                            </Typography>
                        }
                    </CardContent>
                </Card>
            ))}
        </>
    )
}