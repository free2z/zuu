import * as React from 'react';
import * as ReactDOMServer from 'react-dom/server';

import Box from '@mui/material/Box';
import { DataGrid, GridColDef, GridValueGetterParams } from '@mui/x-data-grid';

import { Typography, Link } from "@mui/material"

import { useLiveQuery } from "dexie-react-hooks"
import { Transaction } from '../db/models';
import { getCurrentAccount, db, getCurrentGID } from '../db/db';
import { Navigate } from 'react-router-dom';


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


export function fakeTransactions(): Transaction[] {
    const accgid = getCurrentGID() || ""
    const transactions: Transaction[] = [
        new Transaction(accgid, 1750111, new Date(), "0.001", "aqoixfnoqweifn"),
        new Transaction(accgid, 1739111, new Date(), "0.101", "7qoaifnoqweifn"),
        new Transaction(accgid, 1737111, new Date(), "0.011", "uqoifnoquweifn"),
        new Transaction(accgid, 1736111, new Date(), "0.301", "gqoigfnoqweifn"),
        new Transaction(accgid, 1730511, new Date(), "1.001", "lqoifnojqweifn"),
        new Transaction(accgid, 1730111, new Date(), "0.500", "opqoifnoqweifn"),
        new Transaction(accgid, 1710111, new Date(), "0.001", "aqoixfnoqweifn"),
        new Transaction(accgid, 1709111, new Date(), "0.101", "7qoaifnoqweifn"),
        new Transaction(accgid, 1707111, new Date(), "0.011", "uqoifnoquweifn"),
        new Transaction(accgid, 1706111, new Date(), "0.301", "gqoigfnoqweifn"),
        new Transaction(accgid, 1700511, new Date(), "1.001", "lqoifnojqweifn"),
        new Transaction(accgid, 1700111, new Date(), "0.500", "opqoifnoqweifn"),
        // {
        //     height: 1733133,
        //     datetime: Date(),
        //     amount: "0.001",
        //     txid: 'aowifnqowiecnoiqwejf',
        //     accountID: gid,
        // } as Transaction,
    ];
    return transactions
}


// interface TxGridProps {
//     transactions: Transaction[],
// }

export default function TxGrid() {


    const transactions = useLiveQuery(async () => {

    })

    // const { transactions } = getTrans
    const account = useLiveQuery(async () => {
        const acc = await getCurrentAccount(db)
        console.log("CURRENT", acc)
        if (!acc) {
            // avigate("")
            console.log("DOOOOOO")
            return
        }
        acc.transactions = fakeTransactions()
        return acc
    })

    if (!account || !account.transactions) {
        // console.log("NNO TRSANNCTIONS")
        // TODO: Sync status!!!
        return <>
            {/* <Typography>No Transactions yet</Typography> */}
        </>
    }
    console.log("TRANNSACTIONS", account.transactions)

    return (
        <DataGrid
            rows={account.transactions}
            columns={columns}
            pageSize={10}
            rowsPerPageOptions={[10]}
            // checkboxSelection
            disableSelectionOnClick
            getRowId={(tx) => tx.gid}
        />
    );
}
