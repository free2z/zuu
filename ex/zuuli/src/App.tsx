import React from "react"
import { Outlet } from "react-router-dom"

import { Grid } from "@mui/material"

import TopBar from "./components/TopBar"
import BottomNav from "./components/BottomNav"



export default function App() {

  // const accounts = useLiveQuery(async () => {
  //   // Query the DB using our promise based API.
  //   // The end result will magically become
  //   // observable.
  //   return await readAllAccounts(db)
  // })

  return (
    <Grid container
      // xs={12} sm={11} md={10} lg={8} xl={7}
      style={{ margin: "0 auto" }}
    >
      <TopBar />
      <Grid
        item xs={12}
        style={{
          width: "100%",
          padding: "0.5em",
          // maxHeight: "90vh",
          // minHeight: "70vh",
          // TODO: make more perfect
          // do some math?
          height: "87vh",
        }}
      >
        <Outlet />
      </Grid>
      <BottomNav />
    </Grid >
  )
}
