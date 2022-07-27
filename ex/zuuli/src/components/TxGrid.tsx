import React from 'react';

import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { Link } from "@mui/material"

import { getCurrentID, useGlobalState, Transaction } from '../db/db';


const columns: GridColDef[] = [
    // { field: 'id', headerName: 'ID', width: 90 },
    {
        field: 'txid',
        headerName: 'TXID',
        width: 120,
        editable: false,
        renderCell: (params) => {
            return <Link href={`/${params.row.txid}`}>{params.row.txid}</Link>
        },
    },
    {
        field: 'amount',
        headerName: 'Amt',
        width: 100,
        editable: true,
    },
    // {
    //     field: 'height',
    //     headerName: 'Height',
    //     type: 'number',
    //     // width: 30,
    //     editable: true,
    // },
    {
        field: 'datetime',
        headerName: 'Date',
        width: 150,
        editable: false,
        valueFormatter: (v) => {
            // return v.value.toLocaleDateString('en-US')
            return v.value.toLocaleDateString('zh-Hans-CN')
        }

        // description: 'This column has a value getter and is not sortable.',
        // sortable: false,
        // width: 160,
        // valueGetter: (params: GridValueGetterParams) =>
        //     `${params.row.firstName || ''} ${params.row.lastName || ''}`,
    },
];


// interface TxGridProps {
//     transactions: Transaction[],
// }

export default function TxGrid() {


    const [account, _] = useGlobalState('currentAccount')

    if (!account || !account.transactions) {
        return <>
            {/* <Typography>No Transactions yet</Typography> */}
        </>
    }

    return (
        <DataGrid
            rows={account.transactions}
            columns={columns}
            pageSize={10}
            rowsPerPageOptions={[10]}
            // checkboxSelection
            disableSelectionOnClick
            getRowId={(tx: Transaction) => tx.txid}
        />
    );
}
