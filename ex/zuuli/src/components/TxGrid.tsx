import React from 'react';

import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { Link } from "@mui/material"

import { getCurrentID, useGlobalState, Transaction } from '../db/db';


const columns: GridColDef[] = [
    // https://mui.com/x/api/data-grid/data-grid/
    // https://mui.com/x/react-data-grid/#mit-version
    {
        field: 'txid',
        headerName: 'TXID',
        width: 120,
        editable: false,
        renderCell: (params) => {
            console.log("RENDER", params)
            const s = params.row.txid.toString()
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
