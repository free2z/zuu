import { Delete } from "@mui/icons-material";
import { Box, Typography, Link, IconButton, Stack } from "@mui/material";
import DragDropFileUpload from "./DragDropFileUpload";
import { KYCTaxFormProps } from "./KYCTaxFormStep";

export default function KYCTaxForm(props: KYCTaxFormProps) {
    const { state, dispatch, handleFileSelect, handleDeleteFile } = props;

    const getFormInfo = () => {
        if (state.is_us) {
            return state.is_individual ?
                { formName: "W-9", description: "Upload W-9 Form for US Individuals", url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf" } :
                { formName: "W-9", description: "Upload W-9 Form for US Entities", url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf" };

        } else {
            return state.is_individual ?
                { formName: "W-8BEN", description: "Upload W-8BEN Form for Non-US Individuals", url: "https://www.irs.gov/pub/irs-pdf/fw8ben.pdf" } :
                { formName: "W-8BEN-E", description: "Upload W-8BEN-E Form for Non-US Entities", url: "https://www.irs.gov/pub/irs-pdf/fw8bene.pdf" };
        }
    };

    const formInfo = getFormInfo();

    return (
        <Box component="div" sx={{ mt: 2 }}>
            {!state.tax_form_file_url ? (
                <>
                    <Typography variant="h6" sx={{ mb: 1 }}>
                        {formInfo.description}
                    </Typography>
                    <Typography variant="caption">
                        Please download and fill out the appropriate form:
                    </Typography>
                    <Link href={formInfo.url} target="_blank" sx={{ display: 'block', mt: 1, mb: 2 }}>
                        Download {formInfo.formName} Form
                    </Link>
                    <DragDropFileUpload
                        instructions="Drag and drop your completed PDF tax form here, or click to browse. You do not need to print, sign, and upload the form. We will use e-signature in the next step."
                        disabled={state.uploading}
                        onFileSelect={handleFileSelect}
                    />
                </>
            ) : (
                <>
                    <Typography variant="h6"
                        sx={{ mb: 1 }}
                    >
                        Review and Confirm Your {formInfo.formName} Form
                    </Typography>
                    <Typography variant="caption" color="success">
                        Your form has been uploaded successfully. Please download and review it before proceeding.
                    </Typography>
                    <Stack direction="row"
                        alignItems="center"
                        justifyContent="center"
                    >
                        <Link href={state.tax_form_file_url} target="_blank" sx={{ display: 'block' }}>
                            Download Finished Form
                        </Link>
                        <IconButton
                            onClick={handleDeleteFile}
                        >
                            <Delete />
                        </IconButton>
                    </Stack>
                </>
            )}
        </Box>
    );
}
