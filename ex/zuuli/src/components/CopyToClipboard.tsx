import * as React from "react"

import Tooltip, { TooltipProps } from "@mui/material/Tooltip"
import Zoom from "@mui/material/Zoom"

import copy from "clipboard-copy"

interface ChildProps {
    copy: (content: any) => void
}

interface Props {
    TooltipProps?: Partial<TooltipProps>
    children: (props: ChildProps) => React.ReactElement<any>
}

interface OwnState {
    showTooltip: boolean
}

/**
 * Render prop component that wraps element in a Tooltip that shows "Copied to clipboard!" when the
 * copy function is invoked
 */
class CopyToClipboard extends React.Component<Props, OwnState> {
    public state: OwnState = { showTooltip: false }

    public render() {
        return (
            <Tooltip
                TransitionComponent={Zoom}
                open={this.state.showTooltip}
                title="COPIED"
                leaveDelay={1200}
                onClose={this.handleOnTooltipClose}
                {...(this.props.TooltipProps || {})}
            >
                {
                    this.props.children({
                        copy: this.onCopy,
                    }) as React.ReactElement<any>
                }
            </Tooltip>
        )
    }

    private onCopy = (content: any) => {
        copy(content)
        this.setState({ showTooltip: true })
    }

    private handleOnTooltipClose = () => {
        this.setState({ showTooltip: false })
    }
}

export default CopyToClipboard
