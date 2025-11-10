import { styled, Typography } from "@mui/material";

const CustomTypography = styled(Typography)(({ theme, variant,fontStyle }) => ({  
  ...(variant === "body1" && {
    fontSize: "1.13rem",
    lineHeight: 1.48,
    fontWeight: 400,
    letterSpacing: "0.01em",
    marginBottom: "1.2em",
    marginTop: "1.2em",
  }),
  ...(fontStyle === "italic" && {
    fontStyle: "italic",
    fontSize: "1.2rem",    
    fontFamily: "serif",
    fontWeight: 300,
  }),
}));

export default function (
  variant: string,
  fontStyle: 'italic' | 'normal' = 'normal'
) {
  return function MTypography(props: any) {
    return (
      <CustomTypography
      fontStyle={fontStyle}
        component={fontStyle === 'italic' ? 'span' : 'p'}
        variant={variant}
        {...props}
      />
    );
  };
}
