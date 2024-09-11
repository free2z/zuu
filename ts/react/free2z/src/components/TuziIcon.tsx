import { SvgIcon } from "@mui/material";
import { DefaultComponentProps, OverridableTypeMap } from "@mui/material/OverridableComponent";

import { ReactComponent as TuziSVG } from "../svg/tuzi.svg"


export default function TuziIcon(props: DefaultComponentProps<OverridableTypeMap>) {
    return (
        <SvgIcon
            component={TuziSVG}
            color="primary"
            // viewBox="0 0 400 379"
            // viewBox="0 0 987.000000 981.000000"
            viewBox="0 0 300.000000 284.000000"
            // fontSize="small"
            htmlColor="blue"
            {...props}
        />
    )
}