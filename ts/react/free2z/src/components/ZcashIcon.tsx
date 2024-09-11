import { SvgIcon } from "@mui/material";
import { DefaultComponentProps, OverridableTypeMap } from "@mui/material/OverridableComponent";

import { ReactComponent as ZcashSVG } from "../svg/zcash.svg"


export default function ZcashIcon(props: DefaultComponentProps<OverridableTypeMap>) {
    return (
        <SvgIcon
            component={ZcashSVG}
            color="success"
            viewBox="0 0 987.000000 981.000000"
            fontSize="small"
            htmlColor="green"
            {...props}
        />
    )
}