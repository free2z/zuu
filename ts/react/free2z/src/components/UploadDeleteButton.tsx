import axios from 'axios';
import { useState } from 'react';
import { Button } from '@mui/material';
import Delete from '@mui/icons-material/Delete';

type UploadDeleteButtonProps = {
    finish: () => void,
    uploadId: number,
};

const UploadDeleteButton = (props: UploadDeleteButtonProps) => {
    const { finish, uploadId } = props; // Add uploadItemId if using ID from props
    const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
    const [buttonText, setButtonText] = useState('DELETE');

    const handleClick = () => {
        if (isConfirmingDelete) {
            deleteItem();
        } else {
            setIsConfirmingDelete(true);
            setButtonText('REALLY?');
        }
    };

    const deleteItem = async () => {
        try {
            const response = await axios.delete(
                `/api/myuploads/${uploadId}`
            );
            console.log('Delete response:', response);
            finish();
        } catch (error) {
            console.error('Error deleting item:', error);
            finish();
        }
    };

    return (
        <Button
            fullWidth
            color="warning"
            onClick={handleClick}
        >
            <Delete />
            {buttonText}
        </Button>
    );
};

export default UploadDeleteButton;
