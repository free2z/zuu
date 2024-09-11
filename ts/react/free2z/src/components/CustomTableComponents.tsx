import React, { forwardRef } from 'react';
import { TableBody, TableBodyProps, TableCell, TableCellProps, TableRow, TableRowProps } from '@mui/material';
import { ReactNode } from 'react';

interface CustomTableRowProps extends TableRowProps {
    children: ReactNode;
    node: any; // Adjust the type based on your specific needs
    darkMode: boolean;
}

export const CustomTableRow = forwardRef<HTMLTableRowElement, CustomTableRowProps>(({ children, node, darkMode, ...otherProps }, ref) => {
    const isOdd = Number(node?.position?.start.line) % 2 === 0;

    return (
        <TableRow
            component="tr"
            sx={{
                backgroundColor: (theme) => {
                    let gray = "#f5f5f5";
                    if (darkMode) {
                        gray = "#000000";
                    }
                    return isOdd ? "inherit" : gray;
                },
            }}
            ref={ref}
            {...otherProps}
        >
            {children}
        </TableRow>
    );
});

interface CustomTableBodyProps extends TableBodyProps {
    children: ReactNode;
}

export const CustomTableBody = forwardRef<HTMLTableSectionElement, CustomTableBodyProps>((props, ref) => {
    return (
        <TableBody component="tbody" ref={ref} {...props}>
            {props.children}
        </TableBody>
    );
});
