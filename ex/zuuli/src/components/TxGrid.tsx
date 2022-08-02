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
            // const s = params.row.txid
            const s = params.row.txid.toString()
            // const s = new TextDecoder().decode(params.row.txid);
            return <Link href={`/${s}`}>{s}</Link>
        },
    },
    {
        field: 'value',
        headerName: 'Z',
        width: 100,
        editable: false,
        valueFormatter: (v) => {
            return `${v.value / 100000000}`
            // return v.value
        }
    },
    {
        field: 'memo',
        headerName: 'Memo',
        type: 'string',
        // width: 30,
        editable: false,
    },
    {
        field: 'height',
        headerName: 'Height',
        type: 'number',
        // width: 30,
        editable: false,
    },
    {
        field: 'timestamp',
        headerName: 'Date',
        width: 150,
        editable: false,
        valueFormatter: (v) => {
            // return v.value.toLocaleDateString('en-US')
            // return v.value.toLocaleDateString('zh-Hans-CN')
            const d = new Date(v.value * 1000)
            return `${d.toLocaleDateString('zh-Hans-CN')} ${d.toLocaleTimeString('en-US')}`
        }

        //     // description: 'This column has a value getter and is not sortable.',
        //     // sortable: false,
        //     // width: 160,
        //     // valueGetter: (params: GridValueGetterParams) =>
        //     //     `${params.row.firstName || ''} ${params.row.lastName || ''}`,
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

    // console.log("GRID", account)
    return (
        <DataGrid
            rows={account.transactions}
            columns={columns}
            pageSize={10}
            rowsPerPageOptions={[10]}
            // checkboxSelection
            disableSelectionOnClick
            getRowId={(tx: Transaction) => tx.id_tx}
        />
    );
}
