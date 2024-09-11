import { Backdrop, useMediaQuery } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close"

const DialogBackdrop = ({ ownerState, ...props }: any) => {
  const isSmallHeight = useMediaQuery('(max-height:560px)');

  return (
    <Backdrop {...props}>
      <div onClick={ownerState?.onClose} style={{ position: 'absolute', width: '100%', height: '100%' }}>
        {!isSmallHeight && (
          <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
            <CloseIcon sx={{ fontSize: 48 }} onClick={ownerState?.onClose} />
          </div>
        )}
      </div>
    </Backdrop>
  );
}

export default DialogBackdrop
